#!/usr/bin/env node
// Script to push DB schema — run: npm run db:push

import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

console.log('[DB] Setting up database...');

// Check if drizzle directory exists
if (!existsSync(resolve(root, 'drizzle'))) {
  console.log('[DB] Generating migration...');
  execSync('npx drizzle-kit generate', { cwd: root, stdio: 'inherit' });
}

console.log('[DB] Pushing schema...');
try {
  execSync('npx drizzle-kit push', { cwd: root, stdio: 'inherit' });
  console.log('[DB] Schema pushed successfully');
} catch (err) {
  console.error('[DB] Push failed — ensure DATABASE_URL is set and PostgreSQL is running');
  process.exit(1);
}
