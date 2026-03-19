import fs from "node:fs";
import path from "node:path";

import SQLite from "better-sqlite3";

import { Database } from "@components/database/database";


export type CacheMaintenanceResult = {
  databasePath: string;
  checkpointBusy: number;
  checkpointLogFrames: number;
  checkpointCheckpointedFrames: number;
  pageCount: number;
  freelistCount: number;
};

/**
 * SQLite-backed implementation of the cache persistence interface.
 */
export class SqliteCacheDatabase extends Database {
  private static dbByPath = new Map<string, SQLite.Database>();
  private static backendByPath = new Map<string, SqliteCacheDatabase>();

  private readonly db: SQLite.Database;

  private readonly selectStmt: SQLite.Statement<[string, string], { value: string; expires_at: number }>;
  private readonly upsertStmt: SQLite.Statement<[string, string, string, number]>;
  private readonly deleteStmt: SQLite.Statement<[string, string]>;
  private readonly clearStmt: SQLite.Statement<[string]>;
  private readonly clearExpiredStmt: SQLite.Statement<[number]>;
  private readonly countStmt: SQLite.Statement<[string], { total: number }>;
  private readonly expiredCountStmt: SQLite.Statement<[string, number], { total: number }>;

  public static getOrCreate(filepath?: string): SqliteCacheDatabase {
    
    const dbPath = filepath
            ?? process.env.CACHE_SQLITE_PATH
            ?? path.resolve(process.cwd(), "data", "cache.sqlite");
    
    const existing = this.backendByPath.get(dbPath);
    if (existing) {
      return existing;
    }

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const db = this.dbByPath.get(dbPath) ?? new SQLite(dbPath);
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

  private constructor(db: SQLite.Database) {
    super();
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

  public get(namespace: string, key: string) {
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
