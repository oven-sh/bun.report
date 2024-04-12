// SQLite database acts as a form of cache for already remapped addresses.
// This is used to avoid remapping the same address multiple times.
import { Database } from 'bun:sqlite';
import type { Remap } from '../lib/parser';

const db = new Database('bun-remap.db');

const existing_tables = db.query('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=\'remap\';').all();
if (existing_tables.length === 0) {
  console.log('Initializing Database');
  db.run(`
    CREATE TABLE remap (
      cache_key TEXT PRIMARY KEY,
      remapped_data TEXT
    );
  `);
}

const get_stmt = db.prepare('SELECT remapped_data FROM remap WHERE cache_key = ?');
const insert_stmt = db.prepare('INSERT INTO remap (cache_key, remapped_data) VALUES (?, ?)');

export function getCachedRemap(cache_key: string): Remap | null {
  const result = get_stmt.get(cache_key) as { remapped_data: string } | null;
  if (result) {
    return JSON.parse(result.remapped_data);
  }
  return null;
}

export function putCachedRemap(cache_key: string, remap: Remap) {
  insert_stmt.run(cache_key, JSON.stringify(remap));
}
