import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

export type CacheRow = {
  value: string;
  expiresAt: number;
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
 * Interface for cache persistence backends used by the Cache wrapper.
 */
export interface CacheDatabaseBackend {
  get(namespace: string, key: string): CacheRow | undefined;
  upsert(namespace: string, key: string, value: string, expiresAt: number): void;
  delete(namespace: string, key: string): number;
  clearNamespace(namespace: string): number;
  clearExpired(now: number): number;
  count(namespace: string): number;
  countExpired(namespace: string, now: number): number;
}

/**
 * SQLite-backed implementation of the cache persistence interface.
 */
export class SqliteCacheDatabase implements CacheDatabaseBackend {
  private static dbByPath = new Map<string, Database.Database>();
  private static backendByPath = new Map<string, SqliteCacheDatabase>();

  private readonly db: Database.Database;

  private readonly selectStmt: Database.Statement<[string, string], { value: string; expires_at: number }>;
  private readonly upsertStmt: Database.Statement<[string, string, string, number]>;
  private readonly deleteStmt: Database.Statement<[string, string]>;
  private readonly clearStmt: Database.Statement<[string]>;
  private readonly clearExpiredStmt: Database.Statement<[number]>;
  private readonly countStmt: Database.Statement<[string], { total: number }>;
  private readonly expiredCountStmt: Database.Statement<[string, number], { total: number }>;

  public static getOrCreate(dbPath: string): SqliteCacheDatabase {
    
    
    const existing = this.backendByPath.get(dbPath);
    if (existing) {
      return existing;
    }

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const db = this.dbByPath.get(dbPath) ?? new Database(dbPath);
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

    const backend = new SqliteCacheDatabase(db);
    this.backendByPath.set(dbPath, backend);
    return backend;
  }

  /**
   * Runs WAL checkpoint + VACUUM for each opened cache database.
   */
  public static runMaintenanceAll(): CacheMaintenanceResult[] {
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

  private constructor(db: Database.Database) {
    this.db = db;

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
  }

  public get(namespace: string, key: string): CacheRow | undefined {
    const row = this.selectStmt.get(namespace, key);
    if (!row) {
      return undefined;
    }

    return {
      value: row.value,
      expiresAt: row.expires_at,
    };
  }

  public upsert(namespace: string, key: string, value: string, expiresAt: number): void {
    this.upsertStmt.run(namespace, key, value, expiresAt);
  }

  public delete(namespace: string, key: string): number {
    const result = this.deleteStmt.run(namespace, key);
    return result.changes;
  }

  public clearNamespace(namespace: string): number {
    const result = this.clearStmt.run(namespace);
    return result.changes;
  }

  public clearExpired(now: number): number {
    const result = this.clearExpiredStmt.run(now);
    return result.changes;
  }

  public count(namespace: string): number {
    return this.countStmt.get(namespace)?.total ?? 0;
  }

  public countExpired(namespace: string, now: number): number {
    return this.expiredCountStmt.get(namespace, now)?.total ?? 0;
  }
}
