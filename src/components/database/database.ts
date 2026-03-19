type CacheRow = {
  value: string;
  expiresAt: number;
};

/**
 * abstract class for cache persistence backends used by the Cache wrapper.
 */
export abstract class Database {
  abstract get(namespace: string, key: string): CacheRow | undefined;
  abstract upsert(namespace: string, key: string, value: string, expiresAt: number): void;
  abstract delete(namespace: string, key: string): number;
  abstract clearNamespace(namespace: string): number;
  abstract clearExpired(now: number): number;
  abstract count(namespace: string): number;
  abstract countExpired(namespace: string, now: number): number;
}