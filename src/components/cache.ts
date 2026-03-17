import { LRUCache } from "lru-cache";

/** Options used to configure the underlying LRU cache. */
type CacheOptions = {
  /** Maximum number of entries retained in memory. */
  max: number;
  /** Time to live for each cache entry, in milliseconds. */
  ttl: number;
};

/**
 * Small typed wrapper around `lru-cache` used across the project.
 *
 * It provides a minimal API plus a `getOrSet` helper for lazy async population.
 */
export class Cache<T extends {}> {
  private readonly store: LRUCache<string, T>;

  /**
   * Creates a cache instance.
   * @param options - Cache limits and TTL. Defaults to 100 entries and `CACHE_TTL_MS`.
   */
  constructor(options: CacheOptions = {
    max: 100,
    ttl: +(process.env.CACHE_TTL_MS ?? 5 * 60 * 1000), // 5 minutes
  }) {
    this.store = new LRUCache<string, T>(options);
  }

  /** Returns the cached value for a key, if present and not expired. */
  public get(key: string): T | undefined {
    return this.store.get(key);
  }

  /** Stores a value under the provided key. */
  public set(key: string, value: T): void {
    this.store.set(key, value);
  }

  /** Removes a single key from the cache. */
  public delete(key: string): boolean {
    return this.store.delete(key);
  }

  /** Clears all entries from the cache. */
  public clear(): void {
    this.store.clear();
  }

  /**
   * Returns a cached value when available, otherwise computes, stores, and returns it.
   * @param key - Cache key.
   * @param factory - Async function used to populate the value on cache miss.
   */
  public async getOrSet(key: string, factory: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const value = await factory();
    this.set(key, value);
    return value;
  }
}