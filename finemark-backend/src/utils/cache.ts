type CacheEntry<T = unknown> = {
  value: T;
  expiresAt: number;
};

const _store = new Map<string, CacheEntry>();
const _stats = {
  hits: 0,
  misses: 0,
  sets: 0,
  evictions: 0,
};

function nowMs(): number {
  return Date.now();
}

function isExpired(entry: CacheEntry | undefined, now: number): boolean {
  return !entry || entry.expiresAt <= now;
}

function cleanupExpired(): void {
  const now = nowMs();
  for (const [key, entry] of _store.entries()) {
    if (entry.expiresAt <= now) {
      _store.delete(key);
      _stats.evictions += 1;
    }
  }
}

const _cleanupTimer = setInterval(cleanupExpired, 60_000);
_cleanupTimer.unref?.();

export function cacheGet<T>(key: string): T | undefined {
  const entry = _store.get(key);
  const now = nowMs();
  if (isExpired(entry, now)) {
    if (entry) {
      _store.delete(key);
      _stats.evictions += 1;
    }
    _stats.misses += 1;
    return undefined;
  }
  _stats.hits += 1;
  return (entry as CacheEntry<T>).value;
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): T {
  _store.set(key, { value, expiresAt: nowMs() + ttlMs });
  _stats.sets += 1;
  return value;
}

export async function cacheGetOrSet<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>
): Promise<T> {
  const cached = cacheGet<T>(key);
  if (cached !== undefined) return cached;
  const value = await loader();
  return cacheSet(key, value, ttlMs);
}

export function cacheDelete(key: string): boolean {
  return _store.delete(key);
}

export function cacheDeleteByPrefix(prefix: string): number {
  let n = 0;
  for (const key of _store.keys()) {
    if (key.startsWith(prefix)) {
      _store.delete(key);
      n += 1;
    }
  }
  return n;
}

export function cacheClear(): number {
  const size = _store.size;
  _store.clear();
  return size;
}

export function cacheStats() {
  cleanupExpired();
  return {
    size: _store.size,
    ..._stats,
  };
}
