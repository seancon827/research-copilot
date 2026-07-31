import { fetchJson } from "../http";
import { cached, key, TTL } from "../cache";
import type { CompanyProfile, Quote } from "../types";

/**
 * Keyless last-resort provider.
 *
 * Yahoo's public endpoints are undocumented and can change without notice, so
 * this module is written defensively: every field is optional-chained and the
 * whole thing is only ever reached after the keyed providers have failed. Do
 * not make this the primary source in production.
 */
const PROVIDER = "yahoo";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

interface ChartResponse {
  chart?: {
    result?: {
      meta?: {
        regularMarketPrice?: number;
        previousClose?: number;
        chartPreviousClose?: number;
        regularMarketDayHigh?: number;
        regularMarketDayLow?: number;
        regularMarketVolume?: number;
        fiftyTwoWeekHigh?: number;
        fiftyTwoWeekLow?: number;
        longName?: string;
        shortName?: string;
        exchangeName?: string;
        currency?: string;
      };
      timestamp?: number[];
      indicators?: { adjclose?: { adjclose?: (number | null)[] }[] };
    }[];
    error?: { description?: string };
  };
}

async function chart(ticker: string, range: string, interval: string): Promise<ChartResponse> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker
  )}?range=${range}&interval=${interval}`;
  return fetchJson<ChartResponse>(url, { provider: PROVIDER, headers: { "user-agent": UA } });
}

export async function quote(ticker: string): Promise<Quote> {
  return cached(key("yahoo:quote", { ticker }), TTL.quote, async () => {
    const raw = await chart(ticker, "5d", "1d");
    const meta = raw.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    if (!price) throw new Error(`yahoo returned no price for ${ticker}`);
    const prev = meta?.previousClose ?? meta?.chartPreviousClose ?? price;
    return {
      price,
      change: price - prev,
      changePercent: prev ? ((price - prev) / prev) * 100 : 0,
      dayHigh: meta?.regularMarketDayHigh,
      dayLow: meta?.regularMarketDayLow,
      previousClose: prev,
      volume: meta?.regularMarketVolume,
      fiftyTwoWeekHigh: meta?.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: meta?.fiftyTwoWeekLow,
    };
  });
}

export async function profile(ticker: string): Promise<CompanyProfile> {
  return cached(key("yahoo:profile", { ticker }), TTL.profile, async () => {
    const raw = await chart(ticker, "1d", "1d");
    const meta = raw.chart?.result?.[0]?.meta;
    const name = meta?.longName ?? meta?.shortName;
    if (!name) throw new Error(`yahoo has no profile for ${ticker}`);
    return {
      ticker: ticker.toUpperCase(),
      name,
      exchange: meta?.exchangeName,
      currency: meta?.currency,
    };
  });
}

/** Daily adjusted closes for the price chart. */
export async function priceHistory(
  ticker: string,
  range: "1mo" | "6mo" | "1y" | "5y" = "1y"
): Promise<{ date: string; close: number }[]> {
  return cached(key("yahoo:history", { ticker, range }), 60 * 30, async () => {
    const interval = range === "5y" ? "1wk" : "1d";
    const raw = await chart(ticker, range, interval);
    const result = raw.chart?.result?.[0];
    const stamps = result?.timestamp ?? [];
    const closes = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
    const out: { date: string; close: number }[] = [];
    for (let i = 0; i < stamps.length; i++) {
      const close = closes[i];
      const t = stamps[i];
      if (typeof close === "number" && typeof t === "number") {
        out.push({ date: new Date(t * 1000).toISOString().slice(0, 10), close });
      }
    }
    if (out.length === 0) throw new Error(`yahoo returned no history for ${ticker}`);
    return out;
  });
}
