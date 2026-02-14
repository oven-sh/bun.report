import { $ } from "bun";
import { existsSync } from "node:fs";
import { Octokit } from "octokit";
import { join } from "path";
import type { ResolvedCommit } from "../lib/parser";
import { cache_root } from "./debug-store";
import { AsyncMutex } from "./mutex";
import { git } from "./system-deps";

export const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

const local_clone_dir = process.env.CI_CLONE_DIR ?? join(cache_root, "bun");
const local_clone_git_dir = join(local_clone_dir, ".git");
const commitish_cache = new Map<string, ResolvedCommit>();

if (!existsSync(local_clone_dir) && git) {
  console.log("cloning oven-sh/bun for git commit lookups, may take a while...");

  // notice "-n", we do not actually checkout a tree
  await $`${git} clone https://github.com/oven-sh/bun.git -n ${local_clone_dir}`;
}

const git_fetch_mutex = new AsyncMutex();

/** Returns null if the commit does not exist */
export async function getCommit(commitish: string): Promise<ResolvedCommit | null> {
  if (commitish_cache.has(commitish)) {
    return commitish_cache.get(commitish)!;
  }

  // Try resolving via features.json on S3 first (avoids needing a git clone)
  if (process.env.BUN_DOWNLOAD_BASE) {
    try {
      const res = await fetch(`${process.env.BUN_DOWNLOAD_BASE}/${commitish}/features.json`);
      if (res.ok) {
        const data = await res.json();
        if (data.revision?.length === 40) {
          const result = { oid: data.revision, pr: null };
          commitish_cache.set(commitish, result);
          return result;
        }
      }
    } catch {}
  }

  // Fallback: resolve via local git clone of oven-sh/bun
  let query = await queryGitCliCommitish(commitish);
  if (!query) {
    if (!git_fetch_mutex.locked) {
      using _ = git_fetch_mutex.lockSync();

      await $`${git} --git-dir ${local_clone_git_dir} fetch`;
      query = await queryGitCliCommitish(commitish);
    }
  }

  if (!query) return null;

  const result = {
    oid: query,
    pr: null,
  };
  commitish_cache.set(commitish, result);
  return result;

  // if (!process.env.GITHUB_TOKEN) {
  //   const e: any = new Error("GITHUB_TOKEN is not set");
  //   e.code = "MissingToken";
  //   throw e;
  // }

  // try {
  //   const data = (await octokit.graphql(/* graphql */ `
  //     query {
  //       repository(name: "bun", owner: "oven-sh") {
  //         object(expression: "${commitish}") {
  //           ... on Commit {
  //             oid,
  //             associatedPullRequests(first: 1) {
  //               nodes {
  //                 title,
  //                 number,
  //                 headRefName,
  //               }
  //             }
  //           }
  //         }
  //       }
  //     }
  //   `)) as any;

  //   const object = data.repository.object;
  //   if (!object) {
  //     return null;
  //   }

  //   const oid = object.oid;
  //   const pr = object.associatedPullRequests?.nodes?.[0];

  //   const result = {
  //     oid,
  //     pr: pr
  //       ? {
  //           title: pr.title as string,
  //           number: pr.number as number,
  //           ref: pr.headRefName as string,
  //         }
  //       : null,
  //   } satisfies ResolvedCommit;

  //   commitish_cache.set(commitish, result);
  //   return result;
  // } catch (e: any) {
  //   if (e.status === 422) {
  //     return null;
  //   }
  //   throw e;
  // }
}

async function queryGitCliCommitish(commitish: string) {
  try {
    return (await $`${git} --git-dir ${local_clone_git_dir} rev-parse ${commitish}`.text()).trim();
  } catch {
    return null;
  }
}

export async function getFileAtCommit(commit: ResolvedCommit, path: string): Promise<Buffer | null> {
  try {
    return (await $`${git} --git-dir ${local_clone_git_dir} show ${commit.oid}:${path}`.quiet()).stdout;
  } catch {
    return null;
  }
}

// Fetch once per hour
if (git && !process.env.CI_CLONE_DIR) {
  const timer = setInterval(
    async () => {
      await $`${git} --git-dir ${local_clone_git_dir} fetch`;
    },
    1000 * 60 * 60,
  );
  timer.unref();
}
