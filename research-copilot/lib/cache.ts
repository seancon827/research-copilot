import { env, capabilities } from "./env";

/**
 * Two-layer cache with request coalescing.
 *
 * Layer 1 - in-flight map: if ten components ask for AAPL fundamentals in the
 *   same tick, exactly one upstream call is made and all ten await the same
 *   promise. This is what actually eliminates duplicate API calls; a plain TTL
 *   cache does not, because nothing is cached until the first call returns.
 *
 * Layer 2 - value cache: Upstash REST if configured (shared across serverless
 *   instances), otherwise a bounded in-process Map.
 *
 * TTLs are deliberately per-domain: a quote is stale in seconds, a 10-K never
 * changes once filed.
 */

export const TTL = {
  quote: 30,
  profile: 60 * 60 * 24,
  fundamentals: 60 * 60 * 12,
  earnings: 60 * 60 * 6,
  news: 60 * 15,
  filingIndex: 60 * 60 * 6,
  filingDocument: 60 * 60 * 24 * 30, // immutable once filed
  embedding: 60 * 60 * 24 * 7,
  analysis: 60 * 60 * 4,
} as const;

interface Entry {
  value: unknown;
  expiresAt: number;
}

const MAX_LOCAL_ENTRIES = 500;
const local = new Map<string, Entry>();
const inFlight = new Map<string, Promise<unknown>>();

function localGet(key: string): unknown | undefined {
  const hit = local.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) {
    local.delete(key);
    return undefined;
  }
  // Refresh insertion order so the Map doubles as an LRU.
  local.delete(key);
  local.set(key, hit);
  return hit.value;
}

function localSet(key: string, value: unknown, ttlSeconds: number) {
  if (local.size >= MAX_LOCAL_ENTRIES) {
    const oldest = local.keys().next();
    if (!oldest.done) local.delete(oldest.value);
  }
  local.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

async function redisGet(key: string): Promise<unknown | undefined> {
  if (!capabilities.sharedCache) return undefined;
  try {
    const res = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
      cache: "no-store",
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { result: string | null };
    return body.result ? JSON.parse(body.result) : undefined;
  } catch {
    return undefined; // cache failures must never break a request
  }
}

async function redisSet(key: string, value: unknown, ttlSeconds: number) {
  if (!capabilities.sharedCache) return;
  try {
    await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}?EX=${ttlSeconds}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
      body: JSON.stringify(value),
    });
  } catch {
    /* ignore */
  }
}

/**
 * Get-or-compute. Concurrent callers with the same key share one execution.
 */
export async function cached<T>(key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<T> {
  const localHit = localGet(key);
  if (localHit !== undefined) return localHit as T;

  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;

  const task = (async () => {
    const remote = await redisGet(key);
    if (remote !== undefined) {
      localSet(key, remote, ttlSeconds);
      return remote as T;
    }
    const fresh = await compute();
    localSet(key, fresh, ttlSeconds);
    void redisSet(key, fresh, ttlSeconds);
    return fresh;
  })();

  inFlight.set(key, task);
  try {
    return await task;
  } finally {
    inFlight.delete(key);
  }
}

/** Stable cache keys. Order-independent so callers can't accidentally fork keys. */
export function key(namespace: string, parts: Record<string, string | number | undefined>): string {
  const body = Object.keys(parts)
    .sort()
    .filter((k) => parts[k] !== undefined)
    .map((k) => `${k}=${String(parts[k]).toUpperCase()}`)
    .join("&");
  return `rc:${namespace}:${body}`;
}
