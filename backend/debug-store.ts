import { join, relative, dirname } from 'node:path';
import type { Platform, Arch } from '../lib/util';
import assert from 'node:assert';
import { exists, rm, mkdir, rename } from 'node:fs/promises';
import { unzip } from './system-deps';
import { getCachedDebugFile, putCachedDebugFile } from './db';
import type { ResolvedCommit } from '../lib';
import { octokit } from './git';

const cache_root = join(import.meta.dir, '..', '.cache');

export function storeRoot(platform: Platform, arch: Arch) {
  return join(cache_root, platform + '-' + arch);
}

export async function temp() {
  const path = join(cache_root, 'temp', Math.random().toString(36).slice(2));
  await mkdir(path, { recursive: true });
  return {
    path,
    [Symbol.dispose]: () => { },
  };
}

/** This map serves as a sort of "mutex" */
const in_progress_downloads = new Map<string, Promise<string | null>>();

const map_download_arch = {
  'x86_64': 'x64',
  'x86_64_baseline': 'x64',
  'aarch64': 'arm64',
} as const;

const map_download_os = {
  'windows': 'windows',
  'macos': 'darwin',
  'linux': 'linux',
} as const;

export async function fetchDebugFile(os: Platform, arch: Arch, commit: ResolvedCommit): Promise<string | null> {
  const oid = commit.oid;
  assert(oid.length === 40);

  const store_suffix = os === 'windows' ? '.pdb' : '';

  const root = storeRoot(os, arch);
  const path = join(root, oid[0], oid + store_suffix);

  if (in_progress_downloads.has(path)) {
    return in_progress_downloads.get(path)!;
  }

  const cached_path = getCachedDebugFile(os, arch, oid);
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
    const download_os = map_download_os[os];
    const download_arch = map_download_arch[arch];

    using tmp = await temp();
    const dir = `bun-${download_os}-${download_arch}-profile`;
    const url = `${process.env.BUN_DOWNLOAD_BASE}/${commit}/${dir}.zip`;

    const response = await fetch(url);
    if (response.status === 404) {
      const pr = commit.pr;
      if (pr) {
        try {
          let success = await tryFromPR(os, arch, commit, tmp.path);
          if (!success) {
            in_progress_downloads.delete(path);
            resolve(null);
            return null;
          }
        } catch (e) {
          in_progress_downloads.delete(path);
          resolve(null);
          return null;
        }
      } else {
        in_progress_downloads.delete(path);
        resolve(null);
        return null;
      }
    } else {
      if (response.status !== 200) {
        throw new Error(`Failed to fetch ${url}: ${response.status}`);
      }
      await Bun.write(join(tmp.path, dir + '.zip'), response);
    }

    const subproc = Bun.spawn({
      cmd: [unzip, join(tmp.path, dir + '.zip')],
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

    putCachedDebugFile(os, arch, oid, path);
  } catch (e) {
    await rm(path, { force: true });
    reject(e);
    throw e;
  }
  in_progress_downloads.delete(path);
  resolve(path);
  return path;
}

export async function tryFromPR(os: Platform, arch: Arch, commit: ResolvedCommit, temp: string): Promise<boolean> {
  const oid = commit.oid;
  const pr = commit.pr;
  assert(oid.length === 40);
  assert(pr);

  const download_os = map_download_os[os];
  const download_arch = map_download_arch[arch];

  const data = await octokit.rest.actions.listWorkflowRunsForRepo({
    owner: "oven-sh",
    repo: "bun",
    event: "pull_request",
    status: "completed",
    branch: pr.ref, // Filter by branch associated with the PR
    per_page: 100, // Fetch up to 100 workflow runs
  });
  const run = data.data.workflow_runs
    .filter((run) => run.head_sha === oid)
    .filter((run) => run.path === '.github/workflows/ci.yml')[0];

  if (!run) {
    return false;
  }

  const artifacts = await octokit.rest.actions.listWorkflowRunArtifacts({
    owner: "oven-sh",
    repo: "bun",
    run_id: run.id,
    per_page: 100, // Fetch up to 100 artifacts
  });

  const dir = `bun-${download_os}-${download_arch}-profile`;
  const artifact = artifacts.data.artifacts.find((artifact) => artifact.name === dir);

  if (!artifact) {
    return false;
  }

  const downloaded_artifact = await octokit.rest.actions.downloadArtifact({
    owner: "oven-sh",
    repo: "bun",
    artifact_id: artifact.id,
    archive_format: 'zip',
  });

  await Bun.write(join(temp, 'artifact-download.zip'), downloaded_artifact.data as any);

  const subproc = Bun.spawn({
    cmd: [unzip, join(temp, 'artifact-download.zip')],
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: temp,
  });

  if ((await subproc.exited) !== 0) {
    const e: any = new Error(
      'unzip failed: '
      + await Bun.readableStreamToText(subproc.stderr)
    );
    e.code = 'UnzipFailed';
    throw e;
  }

  return true;
}