import type { Parse, Remap } from "../lib/parser";

const DEFAULT_LIMIT = 1000;
const HOUR_MS = 60 * 60 * 1000;

type Bucket = { hour: number; keys: Set<string>; dropped: number };

/** `commit-prefix/os/arch` entries; an event matches if its commit starts with the prefix and os/arch are equal. */
export function parseBlocklist(list: string | undefined): string[][] {
  return (list ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split("/"));
}

export class FloodGate {
  #limit: number;
  #now: () => number;
  #blocklist: string[][];
  #buckets = new Map<string, Bucket>();

  constructor(limit = DEFAULT_LIMIT, now: () => number = Date.now, blocklist: string[][] = []) {
    this.#limit = limit;
    this.#now = now;
    this.#blocklist = blocklist;
  }

  #blocked(parse: Parse, remap: Remap): boolean {
    for (const [commit, os, arch] of this.#blocklist) {
      if (commit && remap.commit.oid.startsWith(commit) && parse.os === os && parse.arch === arch)
        return true;
    }
    return false;
  }

  /**
   * Returns whether an event for this (build, stack) should be forwarded.
   * A stack already seen for the build in the current hour is always allowed;
   * a new stack is allowed until the build has `limit` distinct stacks this hour.
   */
  shouldForward(parse: Parse, remap: Remap): boolean {
    if (this.#blocked(parse, remap)) return false;

    const key = parse.cache_key;
    if (!key) return true;

    const hour = Math.floor(this.#now() / HOUR_MS);
    const bucketKey = `${remap.commit.oid}/${parse.os}/${parse.arch}/${parse.is_canary ? "canary" : "production"}`;

    let bucket = this.#buckets.get(bucketKey);
    if (!bucket || bucket.hour !== hour) {
      if (bucket) this.#report(bucketKey, bucket);
      if (this.#buckets.size > 256) this.#prune(hour);
      bucket = { hour, keys: new Set(), dropped: 0 };
      this.#buckets.set(bucketKey, bucket);
    }

    if (bucket.keys.has(key)) return true;

    if (bucket.keys.size < this.#limit) {
      bucket.keys.add(key);
      return true;
    }

    if (bucket.dropped === 0) {
      console.warn(
        `flood-gate: ${bucketKey} exceeded ${this.#limit} distinct stacks this hour; dropping new stacks`,
      );
    }
    bucket.dropped++;
    return false;
  }

  #prune(hour: number) {
    for (const [k, b] of this.#buckets) {
      if (b.hour === hour) continue;
      this.#report(k, b);
      this.#buckets.delete(k);
    }
  }

  /** Logs a finished hour for a bucket if it dropped events or used at least half the limit. */
  #report(bucketKey: string, bucket: Bucket) {
    if (bucket.dropped > 0) {
      console.warn(
        `flood-gate: ${bucketKey} dropped ${bucket.dropped} events in hour ${bucket.hour}`,
      );
    } else if (bucket.keys.size * 2 >= this.#limit) {
      console.warn(
        `flood-gate: ${bucketKey} used ${bucket.keys.size}/${this.#limit} distinct stacks in hour ${bucket.hour}`,
      );
    }
  }
}

const envLimit = Math.floor(Number(process.env.BUN_REPORT_MAX_DISTINCT_STACKS_PER_BUILD_HOUR));
export const floodGate = new FloodGate(
  envLimit > 0 ? envLimit : DEFAULT_LIMIT,
  Date.now,
  parseBlocklist(process.env.BUN_REPORT_SENTRY_BLOCKLIST),
);
