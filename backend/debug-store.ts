import { join, relative, dirname } from "node:path";
import type { Platform, Arch } from "../lib/util";
import assert from "node:assert";
import { exists, rm, mkdir, rename } from "node:fs/promises";
import { unzip } from "./system-deps";
import {
  getCachedDebugFile,
  getCachedFeatureData,
  putCachedDebugFile,
  putCachedFeatureData,
} from "./db";
import type { ResolvedCommit } from "../lib";
import { octokit } from "./git";
import type { FeatureConfig } from "./feature";

export const cache_root = join(import.meta.dir, "..", ".cache");

interface DebugInfo {
  file_path: string;
  feature_config: FeatureConfig;
}

export function storeRoot(
  platform: Platform,
  arch: Arch,
  is_canary: boolean | undefined,
) {
  return join(cache_root, platform + "-" + arch + (is_canary ? "-canary" : ""));
}

export async function temp() {
  const path = join(cache_root, "temp", Math.random().toString(36).slice(2));
  await mkdir(path, { recursive: true });
  return {
    path,
    [Symbol.dispose]: () => void rm(path, { force: true }).catch(() => { }),
  };
}

/** This map serves as a sort of "mutex" */
const in_progress_downloads = new Map<string, Promise<DebugInfo>>();

const map_download_arch = {
  x86_64: "x64",
  x86_64_baseline: "x64-baseline",
  aarch64: "aarch64",
} as const;

const map_download_os = {
  windows: "windows",
  macos: "darwin",
  linux: "linux",
} as const;

export async function fetchDebugFile(
  os: Platform,
  arch: Arch,
  commit: ResolvedCommit,
  is_canary: boolean | undefined,
): Promise<DebugInfo> {
  const oid = commit.oid;
  assert(oid.length === 40);

  const store_suffix = os === "windows" ? ".pdb" : "";

  const root = storeRoot(os, arch, is_canary);
  const path = join(root, oid[0], oid + store_suffix);

  if (in_progress_downloads.has(path)) {
    return in_progress_downloads.get(path)!;
  }

  const cached_path = getCachedDebugFile(os, arch, oid);
  if (cached_path) {
    const feature_config = getCachedFeatureData(oid, is_canary)!;
    return {
      file_path: cached_path,
      feature_config: feature_config,
    };
  }

  if (in_progress_downloads.has(path)) {
    return in_progress_downloads.get(path)!;
  }

  if (!process.env.BUN_DOWNLOAD_BASE) {
    const e: any = new Error("BUN_DOWNLOAD_BASE is not set");
    e.code = "MissingToken";
    throw e;
  }

  const { promise, resolve, reject } = Promise.withResolvers<DebugInfo>();
  in_progress_downloads.set(path, promise);
  promise.catch(() => { }); // mark as handled

  let feature_config: FeatureConfig;

  try {
    if (process.env.NODE_ENV === "development") {
      console.log("fetching debug file for", os, arch, oid);
    }

    const download_os = map_download_os[os];
    const download_arch = map_download_arch[arch];

    using tmp = await temp();
    const dir = `bun-${download_os}-${download_arch}-profile`;
    const url = `${process.env.BUN_DOWNLOAD_BASE}/${commit.oid}${is_canary ? "-canary" : ""}/${dir}.zip`;
    console.log(url);

    const response = await fetch(url);
    if (response.status === 404) {
      const pr = commit.pr;
      if (pr) {
        if (process.env.NODE_ENV === "development") {
          console.log(
            "fetching debug file for",
            os,
            arch,
            oid,
            "from PR",
            pr.number,
          );
        }
        try {
          let success = await tryFromPR(os, arch, commit, tmp.path, is_canary);
          if (!success) {
            in_progress_downloads.delete(path);
            const err: any = new Error(
              `Failed to fetch debug file for ${os}-${arch} for PR ${pr.number}`,
            );
            err.code = "DebugInfoUnavailable";
            reject(err);
            throw err;
          }
        } catch (err) {
          in_progress_downloads.delete(path);
          reject(err);
          throw err;
        }
      } else {
        in_progress_downloads.delete(path);
        const err: any = new Error(
          `Failed to fetch debug file for ${os}-${arch} for commit ${commit.oid}`,
        );
        err.code = "DebugInfoUnavailable";
        reject(err);
        throw err;
      }
    } else {
      if (response.status !== 200) {
        throw new Error(`Failed to fetch ${url}: ${response.status}`);
      }
      await Bun.write(join(tmp.path, dir + ".zip"), response);
    }

    const subproc = Bun.spawn({
      cmd: [unzip, join(tmp.path, dir + ".zip")],
      stdio: ["ignore", "pipe", "pipe"],
      cwd: tmp.path,
    });
    if ((await subproc.exited) !== 0) {
      const e: any = new Error(
        "unzip failed: " + (await Bun.readableStreamToText(subproc.stderr)),
      );
      e.code = "UnzipFailed";
      throw e;
    }

    const desired_file = join(
      tmp.path,
      dir,
      "bun" + store_suffix + (os !== "windows" ? "-profile" : ""),
    );
    if (!(await exists(desired_file))) {
      throw new Error(
        `Failed to find ${relative(tmp.path, desired_file)} in extraction`,
      );
    }

    await mkdir(dirname(path), { recursive: true });
    await rename(desired_file, path);

    feature_config =
      getCachedFeatureData(oid, is_canary) ??
      (await fetchFeatureData(oid, is_canary));

    putCachedDebugFile(os, arch, oid, path);
  } catch (e) {
    await rm(path, { force: true });
    reject(e);
    throw e;
  }

  in_progress_downloads.delete(path);
  const result = {
    file_path: path,
    feature_config,
  };
  resolve(result);
  return result;
}

export async function tryFromPR(
  os: Platform,
  arch: Arch,
  commit: ResolvedCommit,
  temp: string,
  is_canary: boolean | undefined,
): Promise<boolean> {
  const oid = commit.oid;
  const pr = commit.pr;
  assert(oid.length === 40);
  assert(pr);

  const download_os = map_download_os[os];
  const download_arch = map_download_arch[arch];

  const data_1 = await octokit.rest.actions.listWorkflowRunsForRepo({
    owner: "oven-sh",
    repo: "bun",
    event: "pull_request",
    status: "completed",
    branch: pr.ref, // Filter by branch associated with the PR
    per_page: 100, // Fetch up to 100 workflow runs
  });
  const data_2 = await octokit.rest.actions.listWorkflowRunsForRepo({
    owner: "oven-sh",
    repo: "bun",
    event: "pull_request",
    status: "in_progress",
    branch: pr.ref, // Filter by branch associated with the PR
    per_page: 100, // Fetch up to 100 workflow runs
  });
  const run = data_1.data.workflow_runs
    .concat(data_2.data.workflow_runs)
    .filter((run) => run.head_sha === oid)
    .filter((run) => run.path === ".github/workflows/ci.yml")[0];

  if (!run) {
    return false;
  }

  console.log("found run", run.id);

  const artifacts = await octokit.rest.actions.listWorkflowRunArtifacts({
    owner: "oven-sh",
    repo: "bun",
    run_id: run.id,
    per_page: 100, // Fetch up to 100 artifacts
  });

  const dir = `bun-${download_os}-${download_arch}-profile`;

  {
    const artifact = artifacts.data.artifacts.find(
      (artifact) => artifact.name === dir,
    );

    if (!artifact) {
      if (process.env.NODE_ENV === "development") {
        console.log(`no artifact ${dir}`);
        console.log(artifacts.data.artifacts.map((a) => a.name));
      }
      return false;
    }

    const downloaded_artifact = await octokit.rest.actions.downloadArtifact({
      owner: "oven-sh",
      repo: "bun",
      artifact_id: artifact.id,
      archive_format: "zip",
    });

    await Bun.write(
      join(temp, "artifact-download.zip"),
      downloaded_artifact.data as any,
    );

    const subproc = Bun.spawn({
      cmd: [unzip, join(temp, "artifact-download.zip")],
      stdio: ["ignore", "pipe", "pipe"],
      cwd: temp,
    });

    if ((await subproc.exited) !== 0) {
      const e: any = new Error(
        "unzip failed: " + (await Bun.readableStreamToText(subproc.stderr)),
      );
      e.code = "UnzipFailed";
      throw e;
    }
  }

  get_features: {
    const artifact = artifacts.data.artifacts.find(
      (artifact) => artifact.name === "bun-feature-data",
    );
    if (!artifact) break get_features;

    const downloaded_artifact = await octokit.rest.actions.downloadArtifact({
      owner: "oven-sh",
      repo: "bun",
      artifact_id: artifact.id,
      archive_format: "zip",
    });

    await Bun.write(
      join(temp, "artifact-download-2.zip"),
      downloaded_artifact.data as any,
    );

    const subproc = Bun.spawn({
      cmd: [unzip, join(temp, "artifact-download-2.zip")],
      stdio: ["ignore", "pipe", "pipe"],
      cwd: temp,
    });
    await subproc.exited;

    try {
      const features = migrateFeatureData(
        await Bun.file(join(temp, "features.json")).json(),
      );
      features.is_pr = true;
      putCachedFeatureData(oid, is_canary, features);
    } catch { }
  }

  return true;
}

export async function fetchFeatureData(
  commit: string,
  is_canary: boolean | undefined,
): Promise<FeatureConfig> {
  const url = `${process.env.BUN_DOWNLOAD_BASE}/${commit}${is_canary ? "-canary" : ""}/features.json`;
  const response = await fetch(url);
  if (response.status !== 200) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return migrateFeatureData(JSON.parse(await response.text()));
}

function migrateFeatureData(any: any): FeatureConfig {
  if (Array.isArray(any)) {
    return {
      features: any,
      is_pr: false,
    };
  }
  any.is_pr ??= false;
  return any;
}
