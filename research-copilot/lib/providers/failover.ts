import { ProviderError } from "../http";
import type { ProviderAttempt } from "../types";

/**
 * Ordered failover across providers.
 *
 * Each candidate is `{ name, enabled, run }`. We try enabled candidates in
 * order, timing each attempt, and return the first success together with the
 * full attempt log. The log is not just for debugging: the UI renders it so the
 * analyst can see *which* vendor a number came from and how degraded the
 * response was. In research tooling, silent failover is a correctness hazard.
 */

export interface Candidate<T> {
  name: string;
  enabled: boolean;
  run: () => Promise<T>;
}

export interface FailoverResult<T> {
  data: T | null;
  attempts: ProviderAttempt[];
}

export async function failover<T>(candidates: Candidate<T>[]): Promise<FailoverResult<T>> {
  const attempts: ProviderAttempt[] = [];

  for (const candidate of candidates) {
    if (!candidate.enabled) {
      attempts.push({ provider: candidate.name, ok: false, ms: 0, error: "not configured" });
      continue;
    }

    const started = Date.now();
    try {
      const data = await candidate.run();
      // A provider can return 200 with nothing useful. Treat empty as failure so
      // we keep walking the chain instead of reporting a false success.
      if (isEmpty(data)) {
        throw new ProviderError(`${candidate.name} returned no usable data`, candidate.name);
      }
      attempts.push({ provider: candidate.name, ok: true, ms: Date.now() - started });
      return { data, attempts };
    } catch (err) {
      attempts.push({
        provider: candidate.name,
        ok: false,
        ms: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { data: null, attempts };
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

/**
 * Run independent fetches concurrently without letting one rejection collapse
 * the whole page. Returns values plus a merged attempt log.
 */
export async function gather<T extends Record<string, Promise<FailoverResult<unknown>>>>(
  tasks: T
): Promise<{
  results: { [K in keyof T]: Awaited<T[K]>["data"] };
  attempts: ProviderAttempt[];
  missing: string[];
}> {
  const entries = Object.entries(tasks) as [keyof T, Promise<FailoverResult<unknown>>][];
  const settled = await Promise.all(
    entries.map(async ([name, task]) => {
      try {
        return [name, await task] as const;
      } catch (err) {
        return [
          name,
          {
            data: null,
            attempts: [
              {
                provider: String(name),
                ok: false,
                ms: 0,
                error: err instanceof Error ? err.message : String(err),
              },
            ],
          } as FailoverResult<unknown>,
        ] as const;
      }
    })
  );

  const results = {} as { [K in keyof T]: Awaited<T[K]>["data"] };
  const attempts: ProviderAttempt[] = [];
  const missing: string[] = [];

  for (const [name, result] of settled) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (results as any)[name] = result.data;
    attempts.push(...result.attempts.map((a) => ({ ...a, provider: `${String(name)}:${a.provider}` })));
    if (result.data === null) missing.push(String(name));
  }

  return { results, attempts, missing };
}
