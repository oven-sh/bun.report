import { join, relative, dirname } from 'node:path';
import type { Platform, Arch } from '../lib/util';
import assert from 'node:assert';
import { exists, rm, mkdir, rename } from 'node:fs/promises';
import { unzip } from './system-deps';
import { getCachedDebugFile, putCachedDebugFile } from './db';

const cache_root = join(import.meta.dir, '..', '.cache');

export function storeRoot(platform: Platform, arch: Arch) {
  return join(cache_root, platform + '-' + arch);
}

export async function temp() {
  const path = join(cache_root, 'temp', Math.random().toString(36).slice(2));
  await mkdir(path, { recursive: true });
  return {
    path,
    [Symbol.dispose]: () => void rm(path, { force: true }).catch(() => { }),
  };
}

/** This map serves as a sort of "mutex" */
const in_progress_downloads = new Map<string, Promise<string | null>>();

export async function fetchDebugFile(os: Platform, arch: Arch, commit: string): Promise<string | null> {
  // assert(commit.length === 40);

  const store_suffix = os === 'windows' ? '.pdb' : '';

  const root = storeRoot(os, arch);
  const path = join(root, commit[0], commit + store_suffix);

  if (in_progress_downloads.has(path)) {
    return in_progress_downloads.get(path)!;
  }

  const cached_path = getCachedDebugFile(os, arch, commit);
  if (cached_path) {
    return cached_path;
  }

  if (in_progress_downloads.has(path)) {
    return in_progress_downloads.get(path)!;
  }

  const { promise, resolve, reject } = Promise.withResolvers<string | null>();
  in_progress_downloads.set(path, promise);
  promise.catch(() => { }); // mark as handled

  try {
    const download_arch = {
      'x86_64': 'x64',
      'x86_64_baseline': 'x64',
      'aarch64': 'arm64',
    }[arch];

    const download_os = {
      'windows': 'windows',
      'macos': 'darwin',
      'linux': 'linux',
    }[os];

    using tmp = await temp();
    const dir = `bun-${download_os}-${download_arch}-profile`;
    const url = `${process.env.BUN_DOWNLOAD_BASE}/${commit}/${dir}.zip`;

    console.log('Fetching ' + url);

    const response = await fetch(url);
    if (response.status === 404) {
      in_progress_downloads.delete(path);
      resolve(null);
      return null;
    }
    if (response.status !== 200) {
      throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }
    await Bun.write(join(tmp.path, 'bun.zip'), response);
    const subproc = Bun.spawn({
      cmd: [unzip, join(tmp.path, 'bun.zip')],
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: tmp.path,
    });
    if ((await subproc.exited) !== 0) {
      const e: any = new Error(
        'unzip failed: '
        + await Bun.readableStreamToText(subproc.stderr)
      );
      e.code = 'UnzipFailed';
      throw e;
    }

    const desired_file = join(tmp.path, dir, 'bun' + store_suffix);
    if (!await exists(desired_file)) {
      throw new Error(`Failed to find ${relative(tmp.path, desired_file)} in extraction`);
    }

    await mkdir(dirname(path), { recursive: true });
    await rename(desired_file, path);

    putCachedDebugFile(os, arch, commit, path);
  } catch (e) {
    await rm(path, { force: true });
    reject(e);
    throw e;
  }
  in_progress_downloads.delete(path);
  resolve(path);
  return path;
}
