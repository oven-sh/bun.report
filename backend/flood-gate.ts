import type { Parse, Remap } from "../lib/parser";

const DEFAULT_LIMIT = 1000;
const HOUR_MS = 60 * 60 * 1000;

type Bucket = { hour: number; keys: Set<string>; warned: boolean };

export class FloodGate {
  #limit: number;
  #now: () => number;
  #buckets = new Map<string, Bucket>();

  constructor(limit = DEFAULT_LIMIT, now: () => number = Date.now) {
    this.#limit = limit;
    this.#now = now;
  }

  /**
   * Returns whether an event for this (build, stack) should be forwarded.
   * A stack already seen for the build in the current hour is always allowed;
   * a new stack is allowed until the build has `limit` distinct stacks this hour.
   */
  shouldForward(parse: Parse, remap: Remap): boolean {
    const key = parse.cache_key;
    if (!key) return true;

    const hour = Math.floor(this.#now() / HOUR_MS);
    const bucketKey = `${remap.commit.oid}/${parse.os}/${parse.arch}`;

    let bucket = this.#buckets.get(bucketKey);
    if (!bucket || bucket.hour !== hour) {
      if (this.#buckets.size > 256) this.#prune(hour);
      bucket = { hour, keys: new Set(), warned: false };
      this.#buckets.set(bucketKey, bucket);
    }

    if (bucket.keys.has(key)) return true;

    if (bucket.keys.size < this.#limit) {
      bucket.keys.add(key);
      return true;
    }

    if (!bucket.warned) {
      bucket.warned = true;
      console.warn(`flood-gate: ${bucketKey} exceeded ${this.#limit} distinct stacks this hour; dropping new stacks`);
    }
    return false;
  }

  #prune(hour: number) {
    for (const [k, b] of this.#buckets) {
      if (b.hour !== hour) this.#buckets.delete(k);
    }
  }
}

const envLimit = Number(process.env.BUN_REPORT_MAX_DISTINCT_STACKS_PER_BUILD_HOUR);
export const floodGate = new FloodGate(Number.isFinite(envLimit) && envLimit > 0 ? envLimit : DEFAULT_LIMIT);
