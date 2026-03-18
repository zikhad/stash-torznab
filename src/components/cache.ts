import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

/** Options used to configure the underlying LRU cache. */
type CacheOptions = {
  /** Namespace used to isolate keys between independent cache usages. */
  namespace: string;
  /** Time to live for each cache entry, in milliseconds. */
  ttl: number;
  /** SQLite file path used to persist cache entries. */
  dbPath: string;
};

export type CacheStats = {
  namespace: string;
  totalEntries: number;
  expiredEntries: number;
};

export type CacheMaintenanceResult = {
  databasePath: string;
  checkpointBusy: number;
  checkpointLogFrames: number;
  checkpointCheckpointedFrames: number;
  pageCount: number;
  freelistCount: number;
};

/**
 * Small typed wrapper around SQLite used across the project.
 *
 * It provides a minimal API plus a `getOrSet` helper for lazy async population,
 * while persisting cache entries across application restarts.
 */
export class Cache<T extends {}> {
  private static dbByPath = new Map<string, Database.Database>();

  private readonly namespace: string;
  private readonly ttl: number;
  private readonly db: Database.Database;
  private readonly inFlight = new Map<string, Promise<T>>();

  private readonly selectStmt: Database.Statement<[string, string], { value: string; expires_at: number }>;
  private readonly upsertStmt: Database.Statement<[string, string, string, number]>;
  private readonly deleteStmt: Database.Statement<[string, string]>;
  private readonly clearStmt: Database.Statement<[string]>;
  private readonly clearExpiredStmt: Database.Statement<[number]>;
  private readonly countStmt: Database.Statement<[string], { total: number }>;
  private readonly expiredCountStmt: Database.Statement<[string, number], { total: number }>;

  /**
   * Creates a cache instance.
   * @param options - Cache options including namespace, TTL, and database path.
   */
  constructor(options: Partial<CacheOptions> = {}) {
    this.namespace = options.namespace ?? "default";
    this.ttl = options.ttl ?? +(process.env.CACHE_TTL_MS ?? 5 * 60 * 1000); // 5 minutes

    const dbPath = options.dbPath
      ?? process.env.CACHE_SQLITE_PATH
      ?? path.resolve(process.cwd(), "data", "cache.sqlite");

    this.db = Cache.getOrCreateDatabase(dbPath);

    this.selectStmt = this.db.prepare(
      `
        SELECT value, expires_at
        FROM cache_entries
        WHERE namespace = ? AND key = ?
      `
    );
    this.upsertStmt = this.db.prepare(
      `
        INSERT INTO cache_entries(namespace, key, value, expires_at)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(namespace, key)
        DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
      `
    );
    this.deleteStmt = this.db.prepare(
      `
        DELETE FROM cache_entries
        WHERE namespace = ? AND key = ?
      `
    );
    this.clearStmt = this.db.prepare(
      `
        DELETE FROM cache_entries
        WHERE namespace = ?
      `
    );
    this.clearExpiredStmt = this.db.prepare(
      `
        DELETE FROM cache_entries
        WHERE expires_at <= ?
      `
    );
    this.countStmt = this.db.prepare(
      `
        SELECT COUNT(*) AS total
        FROM cache_entries
        WHERE namespace = ?
      `
    );
    this.expiredCountStmt = this.db.prepare(
      `
        SELECT COUNT(*) AS total
        FROM cache_entries
        WHERE namespace = ? AND expires_at <= ?
      `
    );

    this.clearExpiredStmt.run(Date.now());
  }

  private static getOrCreateDatabase(dbPath: string): Database.Database {
    const existingDb = this.dbByPath.get(dbPath);
    if (existingDb) {
      return existingDb;
    }

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS cache_entries (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY(namespace, key)
      );

      CREATE INDEX IF NOT EXISTS idx_cache_entries_expires_at
      ON cache_entries(expires_at);
    `);

    this.dbByPath.set(dbPath, db);
    return db;
  }

  /**
   * Runs WAL checkpoint + VACUUM for each opened cache database.
   */
  public static runDatabaseMaintenance(): CacheMaintenanceResult[] {
    const results: CacheMaintenanceResult[] = [];

    for (const [databasePath, db] of this.dbByPath.entries()) {
      const checkpointRow = db
        .prepare("PRAGMA wal_checkpoint(TRUNCATE)")
        .get() as { busy?: number; log?: number; checkpointed?: number } | undefined;

      db.exec("VACUUM");

      const pageCount = (db.prepare("PRAGMA page_count").pluck().get() as number | undefined) ?? 0;
      const freelistCount = (db.prepare("PRAGMA freelist_count").pluck().get() as number | undefined) ?? 0;

      results.push({
        databasePath,
        checkpointBusy: checkpointRow?.busy ?? 0,
        checkpointLogFrames: checkpointRow?.log ?? 0,
        checkpointCheckpointedFrames: checkpointRow?.checkpointed ?? 0,
        pageCount,
        freelistCount,
      });
    }

    return results;
  }

  /** Returns the cached value for a key, if present and not expired. */
  public get(key: string): T | undefined {
    const row = this.selectStmt.get(this.namespace, key);
    if (!row) {
      return undefined;
    }

    if (row.expires_at <= Date.now()) {
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
    this.upsertStmt.run(this.namespace, key, JSON.stringify(value), expiresAt);
  }

  /** Removes a single key from the cache. */
  public delete(key: string): boolean {
    const result = this.deleteStmt.run(this.namespace, key);
    return result.changes > 0;
  }

  /** Clears all entries from this cache namespace. */
  public clear(): void {
    this.clearStmt.run(this.namespace);
  }

  /**
   * Returns total and expired entry counts for this cache namespace.
   */
  public getStats(): CacheStats {
    const now = Date.now();
    const totalEntries = this.countStmt.get(this.namespace)?.total ?? 0;
    const expiredEntries = this.expiredCountStmt.get(this.namespace, now)?.total ?? 0;

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
    const result = this.clearExpiredStmt.run(Date.now());
    return result.changes;
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