import { env } from "../env";
import { fetchJson } from "../http";
import { cached, key, TTL } from "../cache";
import type { CompanyProfile, EarningsEvent, FinancialPeriod } from "../types";

const BASE = "https://www.alphavantage.co/query";
const PROVIDER = "alphavantage";

const url = (fn: string, symbol: string) =>
  `${BASE}?function=${fn}&symbol=${encodeURIComponent(symbol)}&apikey=${env.ALPHAVANTAGE_API_KEY ?? ""}`;

/** Alpha Vantage returns every number as a string, and "None" for nulls. */
const num = (v: unknown): number | undefined => {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string" || v === "None" || v === "-" || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export async function profile(ticker: string): Promise<CompanyProfile> {
  return cached(key("av:overview", { ticker }), TTL.profile, async () => {
    const raw = await fetchJson<Record<string, string>>(url("OVERVIEW", ticker), { provider: PROVIDER });
    if (!raw.Name) throw new Error(`alphavantage has no overview for ${ticker}`);
    return {
      ticker: ticker.toUpperCase(),
      name: raw.Name,
      exchange: raw.Exchange,
      currency: raw.Currency,
      country: raw.Country,
      sector: raw.Sector,
      industry: raw.Industry,
      description: raw.Description,
      cik: raw.CIK,
      marketCap: num(raw.MarketCapitalization),
      sharesOutstanding: num(raw.SharesOutstanding),
    };
  });
}

interface AvReport extends Record<string, string> {
  fiscalDateEnding: string;
}

/**
 * Alpha Vantage splits statements across three calls. On the free tier that is
 * three of your five daily requests, so results are cached hard and the three
 * calls are issued concurrently.
 */
export async function statements(ticker: string, freq: "annual" | "quarterly"): Promise<FinancialPeriod[]> {
  return cached(key("av:stmts", { ticker, freq }), TTL.fundamentals, async () => {
    const bucket = freq === "annual" ? "annualReports" : "quarterlyReports";
    const [income, balance, cash] = await Promise.all([
      fetchJson<Record<string, AvReport[]>>(url("INCOME_STATEMENT", ticker), { provider: PROVIDER }),
      fetchJson<Record<string, AvReport[]>>(url("BALANCE_SHEET", ticker), { provider: PROVIDER }),
      fetchJson<Record<string, AvReport[]>>(url("CASH_FLOW", ticker), { provider: PROVIDER }),
    ]);

    const rows = income[bucket] ?? [];
    if (rows.length === 0) throw new Error(`alphavantage has no ${freq} income statement for ${ticker}`);

    const byDate = <T extends AvReport>(list: T[] | undefined) =>
      new Map((list ?? []).map((r) => [r.fiscalDateEnding, r]));
    const bs = byDate(balance[bucket]);
    const cf = byDate(cash[bucket]);

    return rows
      .slice(0, freq === "annual" ? 8 : 12)
      .map((inc) => {
        const date = inc.fiscalDateEnding;
        const b = bs.get(date) ?? ({} as AvReport);
        const c = cf.get(date) ?? ({} as AvReport);
        const year = Number(date.slice(0, 4));
        const month = Number(date.slice(5, 7));

        const capex = num(c.capitalExpenditures);
        const ocf = num(c.operatingCashflow);

        return {
          period: freq === "annual" ? `FY${year}` : `Q${Math.ceil(month / 3)} ${year}`,
          endDate: date,
          fiscalYear: year,
          fiscalQuarter: freq === "quarterly" ? Math.ceil(month / 3) : undefined,
          revenue: num(inc.totalRevenue),
          costOfRevenue: num(inc.costOfRevenue),
          grossProfit: num(inc.grossProfit),
          operatingIncome: num(inc.operatingIncome),
          netIncome: num(inc.netIncome),
          ebitda: num(inc.ebitda),
          interestExpense: num(inc.interestExpense),
          taxExpense: num(inc.incomeTaxExpense),
          pretaxIncome: num(inc.incomeBeforeTax),
          totalAssets: num(b.totalAssets),
          totalLiabilities: num(b.totalLiabilities),
          totalEquity: num(b.totalShareholderEquity),
          cashAndEquivalents: num(b.cashAndCashEquivalentsAtCarryingValue),
          shortTermInvestments: num(b.shortTermInvestments),
          currentAssets: num(b.totalCurrentAssets),
          currentLiabilities: num(b.totalCurrentLiabilities),
          totalDebt:
            (num(b.shortLongTermDebtTotal) ??
              (num(b.shortTermDebt) ?? 0) + (num(b.longTermDebt) ?? 0)) || undefined,
          operatingCashFlow: ocf,
          capex: capex !== undefined ? Math.abs(capex) : undefined,
          freeCashFlow: ocf !== undefined && capex !== undefined ? ocf - Math.abs(capex) : undefined,
          dividendsPaid: num(c.dividendPayout),
          buybacks: num(c.paymentsForRepurchaseOfCommonStock),
        } satisfies FinancialPeriod;
      })
      .sort((a, b) => a.endDate.localeCompare(b.endDate));
  });
}

export async function earnings(ticker: string): Promise<EarningsEvent[]> {
  return cached(key("av:earnings", { ticker }), TTL.earnings, async () => {
    const raw = await fetchJson<{
      quarterlyEarnings?: {
        fiscalDateEnding: string;
        reportedDate: string;
        reportedEPS: string;
        estimatedEPS: string;
        surprisePercentage: string;
      }[];
    }>(url("EARNINGS", ticker), { provider: PROVIDER });
    const rows = raw.quarterlyEarnings ?? [];
    if (rows.length === 0) throw new Error(`alphavantage has no earnings for ${ticker}`);
    return rows.slice(0, 8).map((r) => {
      const month = Number(r.fiscalDateEnding.slice(5, 7));
      return {
        period: `Q${Math.ceil(month / 3)} ${r.fiscalDateEnding.slice(0, 4)}`,
        reportDate: r.reportedDate,
        epsActual: num(r.reportedEPS),
        epsEstimate: num(r.estimatedEPS),
        epsSurprisePercent: num(r.surprisePercentage),
      };
    });
  });
}
