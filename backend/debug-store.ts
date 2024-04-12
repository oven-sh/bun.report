import { join } from 'node:path';
import type { Platform, Arch } from '../lib/util';
import assert from 'node:assert';
import { exists, rm } from 'node:fs/promises';
import { xz } from './system-deps';

const cache_root = join(import.meta.dir, '..', '.cache');

export function storeRoot(platform: Platform, arch: Arch) {
  return join(cache_root, platform + '-' + arch);
}

const in_progress_downloads = new Map<string, Promise<string | null>>();

export async function fetchDebugFile(os: Platform, arch: Arch, commit: string): Promise<string | null> {
  assert(commit.length === 40);

  const store_suffix = os === 'windows' ? '.pdb' : '';
  const fetch_suffix = os === 'windows' ? '.pdb.xz' : '';

  const root = storeRoot(os, arch);
  const path = join(root, commit[0], commit + store_suffix);

  if (in_progress_downloads.has(path)) {
    return in_progress_downloads.get(path)!;
  }

  if (await exists(path)) {
    return path;
  }

  if (in_progress_downloads.has(path)) {
    return in_progress_downloads.get(path)!;
  }

  const { promise, resolve, reject } = Promise.withResolvers<string | null>();
  in_progress_downloads.set(path, promise);
  try {
    const url = `${process.env.BUN_DOWNLOAD_BASE}/${os}-${arch}/${commit}${fetch_suffix}`;
    const response = await fetch(url);
    if (response.status !== 200) {
      throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }

    if (os === 'windows') {
      if (!response.body) {
        throw new Error(`Failed to fetch ${url}: ${response.status}, body null`);
      }
      const decompress = Bun.spawn({
        cmd: [xz, '-d', '-c'],
        stdio: [response.body, 'pipe', 'inherit'],
      });
      await Bun.write(path, new Response(decompress.stdout));

      if (await decompress.exited !== 0) {
        throw new Error(`Failed to decompress ${url}: ${decompress.exited}`);
      }
    } else {
      // blocked on knowing how this gets uploaded
      throw new Error(`Unsupported OS ${os}`);
    }
  } catch (e) {
    await rm(path, { force: true });
    reject(e);
    throw e;
  }
  in_progress_downloads.delete(path);
  resolve(path);
  return path;
}
