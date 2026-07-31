import { capabilities } from "./env";
import { failover } from "./providers/failover";
import * as finnhub from "./providers/finnhub";
import * as av from "./providers/alphaVantage";
import * as yahoo from "./providers/yahoo";
import * as edgar from "./providers/edgar";
import { clusterNews } from "./news/cluster";
import { deriveSeries, ttm } from "./finance/metrics";
import type {
  CompanyProfile,
  DerivedMetrics,
  EarningsEvent,
  Filing,
  FinancialPeriod,
  NewsCluster,
  ProviderAttempt,
  Quote,
} from "./types";

/**
 * The data layer the API routes and chat tools both call.
 *
 * Every function returns its data plus the provider attempt log, so a partially
 * degraded response is still useful and the degradation is visible rather than
 * silent. Nothing here throws on a provider failure: it returns null data and a
 * populated attempt log.
 */

export async function getProfileAndQuote(ticker: string): Promise<{
  profile: CompanyProfile | null;
  quote: Quote | null;
  attempts: ProviderAttempt[];
}> {
  const [profileResult, quoteResult] = await Promise.all([
    failover<CompanyProfile>([
      { name: "finnhub", enabled: capabilities.finnhub, run: () => finnhub.profile(ticker) },
      { name: "alphavantage", enabled: capabilities.alphaVantage, run: () => av.profile(ticker) },
      { name: "yahoo", enabled: capabilities.yahoo, run: () => yahoo.profile(ticker) },
    ]),
    failover<Quote>([
      { name: "finnhub", enabled: capabilities.finnhub, run: () => finnhub.quote(ticker) },
      { name: "yahoo", enabled: capabilities.yahoo, run: () => yahoo.quote(ticker) },
    ]),
  ]);

  let profile = profileResult.data;

  // Enrich rather than replace: Finnhub has market cap and shares but no business
  // description; Alpha Vantage has the description and sector. Merging gives a
  // complete profile that neither provider returns alone.
  if (profile && !profile.description && capabilities.alphaVantage) {
    try {
      const extra = await av.profile(ticker);
      profile = {
        ...profile,
        description: extra.description ?? profile.description,
        sector: profile.sector ?? extra.sector,
        cik: profile.cik ?? extra.cik,
        marketCap: profile.marketCap ?? extra.marketCap,
        sharesOutstanding: profile.sharesOutstanding ?? extra.sharesOutstanding,
      };
    } catch {
      /* enrichment is best-effort */
    }
  }

  return {
    profile,
    quote: quoteResult.data,
    attempts: [
      ...profileResult.attempts.map((a) => ({ ...a, provider: `profile:${a.provider}` })),
      ...quoteResult.attempts.map((a) => ({ ...a, provider: `quote:${a.provider}` })),
    ],
  };
}

export async function getFundamentals(ticker: string): Promise<{
  annual: FinancialPeriod[] | null;
  quarterly: FinancialPeriod[] | null;
  derived: DerivedMetrics[] | null;
  ttm: FinancialPeriod | null;
  earnings: EarningsEvent[] | null;
  beta?: number;
  attempts: ProviderAttempt[];
}> {
  const [annualResult, quarterlyResult, earningsResult] = await Promise.all([
    failover<FinancialPeriod[]>([
      { name: "finnhub", enabled: capabilities.finnhub, run: () => finnhub.statements(ticker, "annual") },
      { name: "alphavantage", enabled: capabilities.alphaVantage, run: () => av.statements(ticker, "annual") },
    ]),
    failover<FinancialPeriod[]>([
      { name: "finnhub", enabled: capabilities.finnhub, run: () => finnhub.statements(ticker, "quarterly") },
      { name: "alphavantage", enabled: capabilities.alphaVantage, run: () => av.statements(ticker, "quarterly") },
    ]),
    failover<EarningsEvent[]>([
      { name: "finnhub", enabled: capabilities.finnhub, run: () => finnhub.earnings(ticker) },
      { name: "alphavantage", enabled: capabilities.alphaVantage, run: () => av.earnings(ticker) },
    ]),
  ]);

  // Beta is only used as a DCF input; a failure here is not worth surfacing.
  let beta: number | undefined;
  if (capabilities.finnhub) {
    try {
      const metrics = await finnhub.basicFinancials(ticker);
      if (Number.isFinite(metrics.beta)) beta = metrics.beta;
    } catch {
      /* optional */
    }
  }

  const annual = annualResult.data;
  const quarterly = quarterlyResult.data;

  return {
    annual,
    quarterly,
    derived: annual ? deriveSeries(annual) : null,
    ttm: quarterly ? ttm(quarterly) ?? null : null,
    earnings: earningsResult.data,
    beta,
    attempts: [
      ...annualResult.attempts.map((a) => ({ ...a, provider: `annual:${a.provider}` })),
      ...quarterlyResult.attempts.map((a) => ({ ...a, provider: `quarterly:${a.provider}` })),
      ...earningsResult.attempts.map((a) => ({ ...a, provider: `earnings:${a.provider}` })),
    ],
  };
}

export async function getNews(ticker: string): Promise<{
  clusters: NewsCluster[] | null;
  rawCount: number;
  attempts: ProviderAttempt[];
}> {
  const result = await failover([
    { name: "finnhub", enabled: capabilities.finnhub, run: () => finnhub.news(ticker) },
  ]);

  if (!result.data) return { clusters: null, rawCount: 0, attempts: result.attempts };

  const clusters = await clusterNews(result.data);
  return { clusters, rawCount: result.data.length, attempts: result.attempts };
}

export async function getFilings(ticker: string): Promise<{
  filings: Filing[] | null;
  attempts: ProviderAttempt[];
}> {
  const result = await failover<Filing[]>([
    { name: "sec-edgar", enabled: capabilities.edgar, run: () => edgar.filings(ticker) },
  ]);
  return { filings: result.data, attempts: result.attempts };
}

export async function getPriceHistory(ticker: string, range: "1mo" | "6mo" | "1y" | "5y" = "1y") {
  const result = await failover([
    { name: "yahoo", enabled: capabilities.yahoo, run: () => yahoo.priceHistory(ticker, range) },
  ]);
  return { history: result.data, attempts: result.attempts };
}

export async function getPeers(ticker: string): Promise<string[]> {
  if (!capabilities.finnhub) return [];
  try {
    return await finnhub.peers(ticker);
  } catch {
    return [];
  }
}
