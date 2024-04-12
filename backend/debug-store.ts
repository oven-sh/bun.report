import { join } from 'node:path';
import type { Platform, Arch } from '../lib/util';
import assert from 'node:assert';
import { exists } from 'node:fs/promises';

const cache_root = join(import.meta.dir, '..', '.cache');

export function storeRoot(platform: Platform, arch: Arch) {
  return join(cache_root, platform + '-' + arch);
}

export async function fetchDebugFile(os: Platform, arch: Arch, commit: string): Promise<string | null> {
  assert(commit.length === 40);

  const ext = os === 'windows' ? 'pdb' : 'dSYM';

  const root = storeRoot(os, arch);
  const path = join(root, commit[0], commit + '.' + ext);

  if (await exists(path)) {
    return path;
  }

  const url = `${process.env.BUN_DOWNLOAD_BASE}/${os}-${arch}/${commit}.pdb.xz`;
  const response = await fetch(url);
  if (response.status !== 200) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  await Bun.write(path, response);
  return path;
}
