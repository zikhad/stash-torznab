import { Database, SqliteCacheDatabase } from "@components/database";

/** Options used to configure cache behavior and persistence backend. */
type CacheOptions = {
  /** Namespace used to isolate keys between independent cache usages. */
  namespace: string;
  /** Time to live for each cache entry, in milliseconds. */
  ttl?: number;
  /** Optional cache persistence backend implementation. */
  database?: Database;
};

/** Statistics for a single cache namespace. */
export type CacheStats = {
  namespace: string;
  totalEntries: number;
  expiredEntries: number;
};

/**
 * Small typed cache wrapper used across the project.
 *
 * It provides a minimal API plus a `getOrSet` helper for lazy async population,
 * while delegating persistence to a pluggable backend.
 */
export class Cache<T extends {}> {
  /** Namespace used to isolate cache keys between independent usages. */
  private readonly namespace: string;
  /** Time to live in milliseconds for each cache entry. */
  private readonly ttl: number;
  /** Persistence backend for cache entries. */
  private readonly database: Database;
  /** Tracks in-progress factory calls to deduplicate concurrent cache misses for the same key. */
  private readonly inFlight = new Map<string, Promise<T>>();

  /**
   * Creates a cache instance.
   * @param options - Cache options including namespace, TTL, and database path.
   */
  constructor({
    namespace = "default",
    ttl = +(process.env.CACHE_TTL_MS ?? 5 * 60 * 1000), // default to 5 minutes
    database = SqliteCacheDatabase.getOrCreate()
  }: CacheOptions) {
    this.namespace = namespace;
    this.ttl = ttl;
    this.database = database;

    this.database.clearExpired(Date.now());
  }

  /** Returns the cached value for a key, if present and not expired. */
  public get(key: string): T | undefined {
    const row = this.database.get(this.namespace, key);
    if (!row) {
      return undefined;
    }

    if (row.expiresAt <= Date.now()) {
      this.delete(key);
      return undefined;
    }

    try {
      return JSON.parse(row.value) as T;
    } catch {
      this.delete(key);
      return undefined;
    }
  }

  /** Stores a value under the provided key. */
  public set(key: string, value: T): void {
    const expiresAt = Date.now() + this.ttl;
    this.database.upsert(this.namespace, key, JSON.stringify(value), expiresAt);
  }

  /** Removes a single key from the cache. */
  public delete(key: string): boolean {
    const changes = this.database.delete(this.namespace, key);
    return changes > 0;
  }

  /** Clears all entries from this cache namespace. */
  public clear(): void {
    this.database.clearNamespace(this.namespace);
  }

  /**
   * Returns total and expired entry counts for this cache namespace.
   */
  public getStats(): CacheStats {
    const now = Date.now();
    const totalEntries = this.database.count(this.namespace);
    const expiredEntries = this.database.countExpired(this.namespace, now);

    return {
      namespace: this.namespace,
      totalEntries,
      expiredEntries,
    };
  }

  /**
   * Removes expired entries across all namespaces.
   * @returns Number of removed rows.
   */
  public pruneExpired(): number {
    return this.database.clearExpired(Date.now());
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

    const inFlight = this.inFlight.get(key);
    if (inFlight) {
      return inFlight;
    }

    const pending = (async () => {
      const value = await factory();
      this.set(key, value);
      return value;
    })();

    this.inFlight.set(key, pending);
    pending.finally(() => {
      this.inFlight.delete(key);
    });

    return pending;
  }
}