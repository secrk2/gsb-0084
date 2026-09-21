import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const { Pool } = pg;
export const pool = new Pool({ connectionString: config.databaseUrl });

pool.on('error', (err) => {
  console.error('[pg] 空闲连接异常:', err.message);
});

export async function pingDb() {
  await pool.query('SELECT 1');
}

let migrated = false;
export async function migrate() {
  if (migrated) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = await readFile(join(here, 'schema.sql'), 'utf8');
  await pool.query(sql);
  migrated = true;
}
