import assert from 'node:assert';

/**
 * In many places there is some form of global state that is assumed to be
 * owned by one instance of an async function call. AsyncMutex, similar to
 * a Mutex in C/Zig, will give one async context ownership over a resource.
 */
export class AsyncMutex {
  locked: Promise<void> | null = null;
  private resolve_fn: (() => void) | null = null;

  async lock() {
    if (this.locked) await this.unlock();
    this.locked = new Promise<void>((resolve) => this.resolve_fn = resolve);
    return { [Symbol.dispose]: this.resolve_fn! };
  }

  lockSync() {
    assert(this.locked === null);
    this.locked = new Promise<void>((resolve) => this.resolve_fn = resolve);
    return { [Symbol.dispose]: this.resolve_fn! };
  }

  unlock() {
    this.resolve_fn?.();
  }
}

/**
 * Many places we have async functions that perform some, potentially expensive
 * computation, which will usually be cached. If two identical requests come in
 * while the first is still running, we actually want to use the same call's
 * result for both of them. This is less of a mutex and more of a cache.
 */
export class AsyncMutexMap<T> {
  private ongoing = new Map<string, Promise<T>>();

  get(key: string, compute_fn: () => Promise<T>) {
    if (this.ongoing.has(key)) {
      return this.ongoing.get(key)!;
    }

    const result = compute_fn();
    this.ongoing.set(key, result);
    result.finally(() => this.ongoing.delete(key));
    return result;
  }
}
