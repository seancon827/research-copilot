/**
 * One fetch wrapper for every outbound call, so retry/timeout/rate-limit
 * behaviour is uniform and observable.
 *
 * Financial APIs fail in three distinct ways and each needs different handling:
 *   429 / 5xx  -> transient, retry with exponential backoff + jitter
 *   4xx (other)-> permanent for this input, do not retry, fail over to next provider
 *   timeout    -> transient, but budget-bounded so a slow provider can't stall a request
 */

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
    /** Retrying the same provider could plausibly succeed. */
    readonly retryable: boolean = false
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

interface FetchOpts extends RequestInit {
  provider: string;
  /** Per-attempt timeout in ms. */
  timeoutMs?: number;
  retries?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchJson<T>(url: string, opts: FetchOpts): Promise<T> {
  const { provider, timeoutMs = 12_000, retries = 2, ...init } = opts;
  let lastError: ProviderError | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: { accept: "application/json", ...(init.headers ?? {}) },
      });

      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        const body = await res.text().catch(() => "");
        throw new ProviderError(
          `${provider} responded ${res.status}${body ? `: ${body.slice(0, 180)}` : ""}`,
          provider,
          res.status,
          retryable
        );
      }

      const text = await res.text();
      if (!text) throw new ProviderError(`${provider} returned an empty body`, provider, 204, true);

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ProviderError(`${provider} returned non-JSON`, provider, res.status, false);
      }

      // Alpha Vantage signals rate limits with HTTP 200 and a prose body. This
      // is the single most common cause of silent bad data, so catch it here.
      if (json && typeof json === "object") {
        const rec = json as Record<string, unknown>;
        const note = rec["Note"] ?? rec["Information"] ?? rec["error"];
        if (typeof note === "string" && /(call frequency|rate limit|premium)/i.test(note)) {
          throw new ProviderError(`${provider} rate limited: ${note.slice(0, 140)}`, provider, 429, true);
        }
      }

      return json as T;
    } catch (err) {
      const wrapped =
        err instanceof ProviderError
          ? err
          : new ProviderError(
              err instanceof Error && err.name === "AbortError"
                ? `${provider} timed out after ${timeoutMs}ms`
                : `${provider} request failed: ${String(err)}`,
              provider,
              undefined,
              true
            );

      lastError = wrapped;
      if (!wrapped.retryable || attempt === retries) throw wrapped;

      // Exponential backoff with full jitter, capped, to avoid thundering herd
      // when several tickers refresh at once.
      const backoff = Math.min(2_000, 250 * 2 ** attempt);
      await sleep(backoff / 2 + Math.random() * (backoff / 2));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new ProviderError(`${provider} failed`, provider);
}

/** EDGAR and Yahoo return HTML/text, not JSON. */
export async function fetchText(url: string, opts: FetchOpts): Promise<string> {
  const { provider, timeoutMs = 20_000, ...init } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      throw new ProviderError(
        `${provider} responded ${res.status}`,
        provider,
        res.status,
        res.status === 429 || res.status >= 500
      );
    }
    return await res.text();
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(`${provider} request failed: ${String(err)}`, provider, undefined, true);
  } finally {
    clearTimeout(timer);
  }
}
