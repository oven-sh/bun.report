// SQLite database acts as a form of cache for already remapped addresses.
// This is used to avoid remapping the same address multiple times.
import { Database } from 'bun:sqlite';
import type { Remap } from '../lib/parser';
import type { Arch, Platform } from '../lib/util';
import { rm } from 'node:fs/promises';
import { relative } from 'node:path';

const db = new Database('bun-remap.db');

/** Three weeks */
const cache_lifetime_ms = 1000 * 60 * 60 * 24 * 7 * 3;

const existing_tables = db.query('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=\'remap\';').all();
if (existing_tables.length === 0) {
  console.log('Initializing Database');
  db.run(`
    CREATE TABLE remap (
      cache_key TEXT PRIMARY KEY,
      remapped_data TEXT
    );
  `);

  db.run(`
    CREATE TABLE debug_file (
      cache_key TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      last_updated INTEGER NOT NULL
    )
  `);
}

const get_remap_stmt = db.prepare('SELECT remapped_data FROM remap WHERE cache_key = ?');
const insert_remap_stmt = db.prepare('INSERT INTO remap (cache_key, remapped_data) VALUES (?, ?)');

const get_debug_file_stmt = db.prepare('SELECT file_path FROM debug_file WHERE cache_key = ?');
const insert_debug_file_stmt = db.prepare('INSERT INTO debug_file (cache_key, file_path, last_updated) VALUES (?, ?, ?)');
const update_debug_file_stmt = db.prepare('UPDATE debug_file SET last_updated = ? WHERE cache_key = ?');

export function getCachedRemap(cache_key: string): Remap | null {
  const result = get_remap_stmt.get(cache_key) as { remapped_data: string } | null;
  if (result) {
    return JSON.parse(result.remapped_data);
  }
  return null;
}

export function putCachedRemap(cache_key: string, remap: Remap) {
  insert_remap_stmt.run(cache_key, JSON.stringify(remap));
}

export function getCachedDebugFile(os: Platform, arch: Arch, commit: string): string | null {
  const cache_key = `${os}-${arch}-${commit}`;
  const result = get_debug_file_stmt.get(cache_key) as { file_path: string, last_updated: string } | null;
  if (result) {
    update_debug_file_stmt.run(Date.now(), cache_key);
    return result.file_path;
  }
  return null;
}

export function putCachedDebugFile(os: Platform, arch: Arch, commit: string, file_path: string) {
  insert_debug_file_stmt.run(`${os}-${arch}-${commit}`, file_path, Date.now());
}

export async function garbageCollect() {
  const now = new Date();
  const remove_date = new Date(now.getTime() - cache_lifetime_ms);
  const old_files = db
    .query('SELECT * FROM debug_file WHERE last_updated < $date')
    .all({ $date: remove_date.getTime() } as any) as { cache_key: string, file_path: string }[];

  for (const { cache_key, file_path } of old_files) {
    console.log('Remove ' + relative(process.cwd(), file_path));
    await rm(file_path, {});
    db.run('DELETE FROM debug_file WHERE cache_key = ?', [cache_key]);
  }
}
