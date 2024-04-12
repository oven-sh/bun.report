import { Octokit } from "octokit";

export const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
})

const owner = 'oven-sh';
const repo = 'bun';

const commitish_cache = new Map<string, string>();

/** Returns null if the commit does not exist */
export async function getCommit(commitish: string): Promise<string | null> {
  if (commitish_cache.has(commitish)) {
    return commitish_cache.get(commitish)!;
  }

  try {
    const { data } = await octokit.rest.repos.getCommit({
      owner,
      repo,
      ref: commitish,
    });

    commitish_cache.set(commitish, data.sha);
    return data.sha;
  } catch (e: any) {
    if (e.status === 422) {
      return null;
    }
    throw e;
  }
}
