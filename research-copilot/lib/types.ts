/**
 * Domain model.
 *
 * The important type here is `Sourced<T>`. Nothing in this app passes a bare
 * number around: every retrieved value travels with the provider that produced
 * it and the time it was fetched. That is what makes end-to-end citations
 * possible instead of decorative.
 */

export interface Source {
  provider: "finnhub" | "alphavantage" | "polygon" | "yahoo" | "sec-edgar" | "computed";
  url?: string;
  retrievedAt: string; // ISO
  /** Fiscal period the value describes, if applicable, e.g. "FY2024" or "Q2 2025". */
  period?: string;
}

export interface Sourced<T> {
  value: T;
  source: Source;
}

export const sourced = <T>(value: T, source: Source): Sourced<T> => ({ value, source });

export interface CompanyProfile {
  ticker: string;
  name: string;
  exchange?: string;
  currency?: string;
  country?: string;
  sector?: string;
  industry?: string;
  description?: string;
  website?: string;
  ipoDate?: string;
  employees?: number;
  cik?: string;
  logoUrl?: string;
  marketCap?: number; // in USD
  sharesOutstanding?: number; // absolute count
}

export interface Quote {
  price: number;
  change: number;
  changePercent: number;
  dayHigh?: number;
  dayLow?: number;
  previousClose?: number;
  volume?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
}

/** One fiscal period of normalised statement data, in reporting currency units. */
export interface FinancialPeriod {
  period: string; // "FY2024" | "Q3 2025"
  endDate: string; // ISO date
  fiscalYear: number;
  fiscalQuarter?: number;

  revenue?: number;
  costOfRevenue?: number;
  grossProfit?: number;
  operatingIncome?: number;
  netIncome?: number;
  ebitda?: number;
  epsDiluted?: number;
  interestExpense?: number;
  taxExpense?: number;
  pretaxIncome?: number;

  totalAssets?: number;
  totalLiabilities?: number;
  totalEquity?: number;
  cashAndEquivalents?: number;
  shortTermInvestments?: number;
  totalDebt?: number;
  currentAssets?: number;
  currentLiabilities?: number;

  operatingCashFlow?: number;
  capex?: number;
  freeCashFlow?: number;
  dividendsPaid?: number;
  buybacks?: number;
}

/** Ratios and growth rates we derive ourselves rather than trust a vendor for. */
export interface DerivedMetrics {
  period: string;
  grossMargin?: number;
  operatingMargin?: number;
  netMargin?: number;
  ebitdaMargin?: number;
  fcfMargin?: number;
  roe?: number;
  roic?: number;
  netDebt?: number;
  netDebtToEbitda?: number;
  currentRatio?: number;
  revenueGrowthYoY?: number;
  epsGrowthYoY?: number;
  fcfConversion?: number; // FCF / net income
}

export interface EarningsEvent {
  period: string;
  reportDate: string;
  epsActual?: number;
  epsEstimate?: number;
  epsSurprisePercent?: number;
  revenueActual?: number;
  revenueEstimate?: number;
}

export interface Filing {
  form: "10-K" | "10-Q" | "8-K" | string;
  filedAt: string;
  accessionNumber: string;
  primaryDocUrl: string;
  reportPeriod?: string;
  description?: string;
}

export interface NewsArticle {
  id: string;
  headline: string;
  summary?: string;
  url: string;
  source: string;
  publishedAt: string;
  imageUrl?: string;
}

export interface NewsCluster {
  id: string;
  /** The article we consider the best representative of the cluster. */
  lead: NewsArticle;
  members: NewsArticle[];
  /** 0-100, derived from corroboration, source tier and recency. */
  importance: number;
  /** Filled in by the labelling pass. */
  label?: string;
  sentiment?: -1 | 0 | 1;
  summary?: string;
}

/** A single piece of retrieved evidence the model is allowed to cite. */
export interface Evidence {
  /** Short stable id used in model output, e.g. "F3", "N7", "S2". */
  id: string;
  kind: "financial" | "news" | "filing" | "earnings" | "quote" | "profile" | "computed";
  /** Human-readable statement of the fact, as shown in the citation drawer. */
  text: string;
  url?: string;
  provider: string;
  asOf: string;
}

export interface ProviderAttempt {
  provider: string;
  ok: boolean;
  ms: number;
  error?: string;
}

/** Every API response carries a diagnostics block; the UI renders it as a status rail. */
export interface Envelope<T> {
  data: T | null;
  attempts: ProviderAttempt[];
  warnings: string[];
  /** Fields we could not obtain from any provider. Shown as "not available". */
  missing: string[];
}
