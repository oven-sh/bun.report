import { Octokit } from "octokit";
import type { ResolvedCommit } from "../lib/parser";

export const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

const commitish_cache = new Map<string, ResolvedCommit>();

/** Returns null if the commit does not exist */
export async function getCommit(
  commitish: string,
): Promise<ResolvedCommit | null> {
  if (commitish_cache.has(commitish)) {
    return commitish_cache.get(commitish)!;
  }

  if (!process.env.GITHUB_TOKEN) {
    const e: any = new Error("GITHUB_TOKEN is not set");
    e.code = "MissingToken";
    throw e;
  }

  try {
    const data = (await octokit.graphql(/* graphql */ `
      query {
        repository(name: "bun", owner: "oven-sh") {
          object(expression: "${commitish}") {
            ... on Commit {
              oid,
              associatedPullRequests(first: 1) {
                nodes {
                  title,
                  number,
                  headRefName,
                }
              }
            }
          }
        }
      }
    `)) as any;

    const object = data.repository.object;
    if (!object) {
      return null;
    }

    const oid = object.oid;
    const pr = object.associatedPullRequests?.nodes?.[0];

    const result = {
      oid,
      pr: pr
        ? {
            title: pr.title as string,
            number: pr.number as number,
            ref: pr.headRefName as string,
          }
        : null,
    } satisfies ResolvedCommit;

    commitish_cache.set(commitish, result);
    return result;
  } catch (e: any) {
    if (e.status === 422) {
      return null;
    }
    throw e;
  }
}
