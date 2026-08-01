import { env } from "../env";
import { fetchJson } from "../http";
import { cached, key, TTL } from "../cache";
import type { CompanyProfile, EarningsEvent, FinancialPeriod, NewsArticle, Quote } from "../types";

const BASE = "https://finnhub.io/api/v1";
const PROVIDER = "finnhub";

const url = (path: string, params: Record<string, string | number>) => {
  const q = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), token: env.FINNHUB_API_KEY ?? "" });
  return `${BASE}${path}?${q.toString()}`;
};

export async function profile(ticker: string): Promise<CompanyProfile> {
  return cached(key("finnhub:profile", { ticker }), TTL.profile, async () => {
    const raw = await fetchJson<Record<string, unknown>>(url("/stock/profile2", { symbol: ticker }), {
      provider: PROVIDER,
    });
    const n = (k: string) => (typeof raw[k] === "number" ? (raw[k] as number) : undefined);
    const s = (k: string) => (typeof raw[k] === "string" && raw[k] ? (raw[k] as string) : undefined);

    if (!s("name")) throw new Error(`finnhub has no profile for ${ticker}`);

    return {
      ticker: ticker.toUpperCase(),
      name: s("name")!,
      exchange: s("exchange"),
      currency: s("currency"),
      country: s("country"),
      industry: s("finnhubIndustry"),
      website: s("weburl"),
      ipoDate: s("ipo"),
      logoUrl: s("logo"),
      // Finnhub reports marketCapitalization in millions of the listing currency.
      marketCap: n("marketCapitalization") ? n("marketCapitalization")! * 1e6 : undefined,
      sharesOutstanding: n("shareOutstanding") ? n("shareOutstanding")! * 1e6 : undefined,
    };
  });
}

export async function quote(ticker: string): Promise<Quote> {
  return cached(key("finnhub:quote", { ticker }), TTL.quote, async () => {
    const raw = await fetchJson<Record<string, number>>(url("/quote", { symbol: ticker }), { provider: PROVIDER });
    if (!raw.c) throw new Error(`finnhub returned no price for ${ticker}`);
    return {
      price: raw.c,
      change: raw.d ?? 0,
      changePercent: raw.dp ?? 0,
      dayHigh: raw.h,
      dayLow: raw.l,
      previousClose: raw.pc,
    };
  });
}

/**
 * Finnhub's `financials-reported` endpoint returns as-filed XBRL concepts. Tag
 * names are not stable across filers, so we resolve each metric by trying a
 * prioritised list of concept names and taking the first match. This is the
 * unglamorous core of fundamentals normalisation.
 */
const CONCEPTS: Record<keyof FinancialPeriod & string, string[]> = {
  revenue: [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
    "TotalRevenues",
  ],
  costOfRevenue: ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold"],
  grossProfit: ["GrossProfit"],
  operatingIncome: ["OperatingIncomeLoss"],
  netIncome: ["NetIncomeLoss", "ProfitLoss"],
  epsDiluted: ["EarningsPerShareDiluted"],
  interestExpense: ["InterestExpense", "InterestIncomeExpenseNet"],
  taxExpense: ["IncomeTaxExpenseBenefit"],
  pretaxIncome: ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest"],
  totalAssets: ["Assets"],
  totalLiabilities: ["Liabilities"],
  totalEquity: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
  cashAndEquivalents: ["CashAndCashEquivalentsAtCarryingValue"],
  shortTermInvestments: ["ShortTermInvestments", "MarketableSecuritiesCurrent"],
  currentAssets: ["AssetsCurrent"],
  currentLiabilities: ["LiabilitiesCurrent"],
  operatingCashFlow: ["NetCashProvidedByUsedInOperatingActivities"],
  capex: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
  dividendsPaid: ["PaymentsOfDividendsCommonStock", "PaymentsOfDividends"],
  buybacks: ["PaymentsForRepurchaseOfCommonStock"],
} as Record<string, string[]>;

interface ReportedRow {
  year: number;
  quarter: number;
  endDate: string;
  form: string;
  report: { bs?: Concept[]; ic?: Concept[]; cf?: Concept[] };
}
interface Concept {
  concept?: string;
  label?: string;
  value?: number | string;
}

export async function statements(ticker: string, freq: "annual" | "quarterly"): Promise<FinancialPeriod[]> {
  return cached(key("finnhub:stmts", { ticker, freq }), TTL.fundamentals, async () => {
    const raw = await fetchJson<{ data?: ReportedRow[] }>(
      url("/stock/financials-reported", { symbol: ticker, freq }),
      { provider: PROVIDER, timeoutMs: 20_000 }
    );
    const rows = raw.data ?? [];
    if (rows.length === 0) throw new Error(`finnhub has no ${freq} statements for ${ticker}`);

    return rows
      .slice(0, freq === "annual" ? 8 : 12)
      .map((row) => {
        const all = [...(row.report.ic ?? []), ...(row.report.bs ?? []), ...(row.report.cf ?? [])];
        const index = new Map<string, number>();
        for (const c of all) {
          const name = (c.concept ?? "").replace(/^[A-Za-z][A-Za-z0-9-]*[:_]/, "");
          const num = typeof c.value === "number" ? c.value : Number(c.value);
          if (name && Number.isFinite(num) && !index.has(name)) index.set(name, num);
        }
        const pick = (field:keyof typeof CONCEPTS): number | undefined => {
          for (const concept of CONCEPTS[field] ?? []) {
            const v = index.get(concept);
            if (v !== undefined) return v;
          }
          return undefined;
        };

        const period: FinancialPeriod = {
          period: freq === "annual" ? `FY${row.year}` : `Q${row.quarter} ${row.year}`,
          endDate: row.endDate,
          fiscalYear: row.year,
          fiscalQuarter: freq === "quarterly" ? row.quarter : undefined,
        };
        for (const field of Object.keys(CONCEPTS) as (keyof typeof CONCEPTS)[]) {
          const v = pick(field);
          if (v !== undefined) (period as unknown as Record<string, unknown>)[field] = v;
        }
        // capex is reported as a positive outflow; normalise to a positive magnitude
        if (period.capex !== undefined) period.capex = Math.abs(period.capex);
        return period;
      })
      .sort((a, b) => a.endDate.localeCompare(b.endDate));
  });
}

export async function earnings(ticker: string): Promise<EarningsEvent[]> {
  return cached(key("finnhub:earnings", { ticker }), TTL.earnings, async () => {
    const raw = await fetchJson<
      { period: string; actual: number | null; estimate: number | null; surprisePercent: number | null; quarter: number; year: number }[]
    >(url("/stock/earnings", { symbol: ticker }), { provider: PROVIDER });
    if (!Array.isArray(raw) || raw.length === 0) throw new Error(`finnhub has no earnings for ${ticker}`);
    return raw.slice(0, 8).map((r) => ({
      period: `Q${r.quarter} ${r.year}`,
      reportDate: r.period,
      epsActual: r.actual ?? undefined,
      epsEstimate: r.estimate ?? undefined,
      epsSurprisePercent: r.surprisePercent ?? undefined,
    }));
  });
}

export async function news(ticker: string, days = 14): Promise<NewsArticle[]> {
  return cached(key("finnhub:news", { ticker, days }), TTL.news, async () => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const raw = await fetchJson<
      { id: number; headline: string; summary: string; url: string; source: string; datetime: number; image?: string }[]
    >(url("/company-news", { symbol: ticker, from: iso(from), to: iso(to) }), { provider: PROVIDER });
    if (!Array.isArray(raw) || raw.length === 0) throw new Error(`finnhub has no news for ${ticker}`);
    return raw
      .filter((a) => a.headline && a.url)
      .slice(0, 60)
      .map((a) => ({
        id: `fh-${a.id}`,
        headline: a.headline,
        summary: a.summary || undefined,
        url: a.url,
        source: a.source,
        publishedAt: new Date(a.datetime * 1000).toISOString(),
        imageUrl: a.image || undefined,
      }));
  });
}

/** Peer tickers, used to build the comparables table. */
export async function peers(ticker: string): Promise<string[]> {
  return cached(key("finnhub:peers", { ticker }), TTL.profile, async () => {
    const raw = await fetchJson<string[]>(url("/stock/peers", { symbol: ticker }), { provider: PROVIDER });
    if (!Array.isArray(raw)) throw new Error("finnhub peers unavailable");
    return raw.filter((p) => p.toUpperCase() !== ticker.toUpperCase()).slice(0, 8);
  });
}

/** Vendor-computed ratios. We prefer our own, but these fill gaps like beta. */
export async function basicFinancials(ticker: string): Promise<Record<string, number>> {
  return cached(key("finnhub:basic", { ticker }), TTL.fundamentals, async () => {
    const raw = await fetchJson<{ metric?: Record<string, number> }>(
      url("/stock/metric", { symbol: ticker, metric: "all" }),
      { provider: PROVIDER }
    );
    if (!raw.metric) throw new Error("finnhub metrics unavailable");
    return raw.metric;
  });
}
