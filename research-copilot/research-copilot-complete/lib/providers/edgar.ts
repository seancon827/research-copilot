import { env } from "../env";
import { fetchJson, fetchText, ProviderError } from "../http";
import { cached, key, TTL } from "../cache";
import type { Filing } from "../types";

/**
 * SEC EDGAR access.
 *
 * Three rules the SEC enforces and that break naive implementations:
 *  1. A descriptive User-Agent with a contact address is mandatory; without it
 *     you get 403s that look like outages.
 *  2. Max ~10 requests/second. We serialise document fetches through a tiny
 *     queue rather than firing Promise.all over ten filings.
 *  3. CIKs are zero-padded to 10 digits in the submissions API but not in the
 *     ticker map. Getting this wrong yields 404s on valid tickers.
 */
const PROVIDER = "sec-edgar";
const HEADERS = { "user-agent": env.SEC_USER_AGENT, "accept-encoding": "gzip, deflate" };

// --- minimal rate limiter: serialise EDGAR calls with a floor delay ---------
let chain: Promise<unknown> = Promise.resolve();
const MIN_GAP_MS = 120;
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      const elapsed = Date.now() - started;
      if (elapsed < MIN_GAP_MS) await new Promise((r) => setTimeout(r, MIN_GAP_MS - elapsed));
    }
  });
  chain = run.catch(() => undefined);
  return run as Promise<T>;
}

/** Resolve a ticker to a zero-padded CIK using the SEC's canonical map. */
export async function resolveCik(ticker: string): Promise<string> {
  const map = await cached(key("edgar:tickermap", {}), 60 * 60 * 24, async () =>
    throttled(() =>
      fetchJson<Record<string, { cik_str: number; ticker: string; title: string }>>(
        "https://www.sec.gov/files/company_tickers.json",
        { provider: PROVIDER, headers: HEADERS, timeoutMs: 25_000 }
      )
    )
  );

  const target = ticker.toUpperCase();
  for (const entry of Object.values(map)) {
    if (entry.ticker?.toUpperCase() === target) return String(entry.cik_str).padStart(10, "0");
  }
  throw new ProviderError(`No SEC registrant found for ${target}`, PROVIDER, 404, false);
}

interface Submissions {
  name: string;
  sic?: string;
  sicDescription?: string;
  filings: {
    recent: {
      accessionNumber: string[];
      form: string[];
      filingDate: string[];
      reportDate: string[];
      primaryDocument: string[];
      primaryDocDescription: string[];
    };
  };
}

/** Recent filings, optionally filtered to specific forms. */
export async function filings(ticker: string, forms: string[] = ["10-K", "10-Q", "8-K"]): Promise<Filing[]> {
  return cached(key("edgar:filings", { ticker, forms: forms.join(",") }), TTL.filingIndex, async () => {
    const cik = await resolveCik(ticker);
    const subs = await throttled(() =>
      fetchJson<Submissions>(`https://data.sec.gov/submissions/CIK${cik}.json`, {
        provider: PROVIDER,
        headers: HEADERS,
        timeoutMs: 25_000,
      })
    );

    const r = subs.filings.recent;
    const out: Filing[] = [];
    const cikPlain = String(Number(cik)); // path segment is unpadded

    for (let i = 0; i < r.accessionNumber.length; i++) {
      const form = r.form[i];
      if (!form || !forms.includes(form)) continue;
      const accession = r.accessionNumber[i];
      const doc = r.primaryDocument[i];
      if (!accession || !doc) continue;

      out.push({
        form,
        filedAt: r.filingDate[i] ?? "",
        reportPeriod: r.reportDate[i] || undefined,
        accessionNumber: accession,
        description: r.primaryDocDescription[i] || undefined,
        primaryDocUrl: `https://www.sec.gov/Archives/edgar/data/${cikPlain}/${accession.replace(
          /-/g,
          ""
        )}/${doc}`,
      });
      // Cap per form type so an 8-K-heavy filer doesn't crowd out the 10-K.
      if (out.filter((f) => f.form === form).length >= (form === "8-K" ? 6 : 4)) {
        forms = forms.filter((f) => f !== form || out.filter((x) => x.form === f).length < (f === "8-K" ? 6 : 4));
      }
    }

    if (out.length === 0) throw new ProviderError(`No matching filings for ${ticker}`, PROVIDER, 404, false);
    return out.sort((a, b) => b.filedAt.localeCompare(a.filedAt));
  });
}

/**
 * Strip an EDGAR HTML document to readable text.
 *
 * We deliberately avoid a DOM parser: filings routinely exceed 10 MB and
 * jsdom on a serverless function is both slow and memory-hungry. A staged regex
 * pipeline handles real filings well because their markup is machine-generated
 * and highly repetitive.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // XBRL inline tags carry no prose; drop the wrapper, keep the content.
    .replace(/<\/?(ix|xbrli|link|xlink)[^>]*>/gi, " ")
    // Preserve block boundaries so section headings stay on their own lines.
    .replace(/<\/(p|div|tr|h[1-6]|li|table)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/td>/gi, "\t")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Fetch a filing's primary document as plain text. Filings are immutable, so cache is long. */
export async function filingText(url: string): Promise<string> {
  return cached(key("edgar:doc", { url }), TTL.filingDocument, async () => {
    const html = await throttled(() =>
      fetchText(url, { provider: PROVIDER, headers: HEADERS, timeoutMs: 40_000 })
    );
    const text = htmlToText(html);
    // Hard cap protects downstream memory; section extraction runs before this
    // matters for 10-Ks because we slice by Item anyway.
    return text.slice(0, 3_000_000);
  });
}
