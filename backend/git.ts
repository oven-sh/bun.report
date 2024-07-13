import { Octokit } from "octokit";
import type { ResolvedCommit } from "../lib/parser";
import { existsSync } from 'node:fs';
import { git } from "./system-deps";
import { cache_root, storeRoot } from "./debug-store";
import { $ } from "bun";
import { join } from 'path';

export const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

const local_clone_dir = join(cache_root, 'bun');
const local_clone_git_dir = join(cache_root, 'bun', '.git');
const commitish_cache = new Map<string, ResolvedCommit>();

if (!existsSync(local_clone_dir) && git) {
  console.log('cloning oven-sh/bun for git commit lookups, may take a while...')

  // notice "-n", we do not actually checkout a tree
  await $`${git} clone https://github.com/oven-sh/bun.git -n ${local_clone_dir}`;
}

/** Returns null if the commit does not exist */
export async function getCommit(
  commitish: string,
): Promise<ResolvedCommit | null> {
  if (commitish_cache.has(commitish)) {
    return commitish_cache.get(commitish)!;
  }

  // This used to use the GitHub API, but now that bun has over 10k commits, you
  // need more than 7 chars to lookup a commit hash. We will eventually bump up
  // the bun binary to have more, but old builds will still use those commits.
  // 
  // The switch has also regressed the ability to return PR-related information,
  // but in practice this had not really worked out, so it is disabled until
  // further notice.

  let query = await queryGitCliCommitish(commitish);
  if (!query) {
    await $`${git} --git-dir ${local_clone_git_dir} fetch`;
    query = await queryGitCliCommitish(commitish);
  }

  if (!query) return null;

  return {
    oid: query,
    pr: null,
  }

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

// Fetch once per hour
if (git) {
  const timer = setInterval(async () => {
    await $`${git} --git-dir ${local_clone_git_dir} fetch`;
  }, 1000 * 60 * 60);
  timer.unref();
}
