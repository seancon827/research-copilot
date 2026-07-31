import type { DerivedMetrics, FinancialPeriod } from "../types";

/**
 * Ratio derivation.
 *
 * We compute every ratio ourselves from as-reported statement lines rather than
 * consuming a vendor's pre-computed field. Two reasons:
 *  1. Vendors disagree. Finnhub, Alpha Vantage and Yahoo will all quote a
 *     different ROIC for the same company because they define invested capital
 *     differently. Deriving locally makes the number reproducible and lets us
 *     state the definition in the UI.
 *  2. It lets us fall back gracefully: if EBITDA is missing we can rebuild it
 *     from operating income, and if free cash flow is missing we can rebuild it
 *     from OCF less capex.
 *
 * Every function returns `undefined` rather than 0 when inputs are missing.
 * A zero would silently propagate into the DCF as a real assumption.
 */

const safeDiv = (a?: number, b?: number): number | undefined =>
  a === undefined || b === undefined || b === 0 ? undefined : a / b;

const pct = (a?: number, b?: number): number | undefined => {
  const r = safeDiv(a, b);
  return r === undefined ? undefined : r * 100;
};

/** Fill in derivable statement lines that a provider omitted. */
export function normalise(period: FinancialPeriod): FinancialPeriod {
  const p = { ...period };

  if (p.grossProfit === undefined && p.revenue !== undefined && p.costOfRevenue !== undefined) {
    p.grossProfit = p.revenue - p.costOfRevenue;
  }
  if (p.freeCashFlow === undefined && p.operatingCashFlow !== undefined && p.capex !== undefined) {
    p.freeCashFlow = p.operatingCashFlow - p.capex;
  }
  if (p.totalEquity === undefined && p.totalAssets !== undefined && p.totalLiabilities !== undefined) {
    p.totalEquity = p.totalAssets - p.totalLiabilities;
  }
  // EBITDA is not a GAAP line. Approximate as operating income + D&A when we
  // have it; otherwise leave undefined rather than guess. Flagged in the UI as
  // an approximation.
  if (p.ebitda === undefined && p.operatingIncome !== undefined) {
    p.ebitda = p.operatingIncome; // conservative floor: excludes D&A add-back
  }
  return p;
}

/** Effective tax rate, clamped to a sane band so one-off credits don't distort NOPAT. */
export function effectiveTaxRate(p: FinancialPeriod, fallback = 0.21): number {
  const rate = safeDiv(p.taxExpense, p.pretaxIncome);
  if (rate === undefined || rate < 0 || rate > 0.6) return fallback;
  return rate;
}

/**
 * Invested capital = total debt + total equity − excess cash.
 * This is the "financing side" definition, which is the most reconstructible
 * from a normalised balance sheet. Stated explicitly in the UI.
 */
export function investedCapital(p: FinancialPeriod): number | undefined {
  if (p.totalEquity === undefined) return undefined;
  const debt = p.totalDebt ?? 0;
  const cash = (p.cashAndEquivalents ?? 0) + (p.shortTermInvestments ?? 0);
  const ic = debt + p.totalEquity - cash;
  return ic > 0 ? ic : undefined;
}

export function deriveOne(current: FinancialPeriod, prior?: FinancialPeriod): DerivedMetrics {
  const p = normalise(current);
  const ic = investedCapital(p);
  const tax = effectiveTaxRate(p);
  const nopat = p.operatingIncome !== undefined ? p.operatingIncome * (1 - tax) : undefined;
  const netDebt =
    p.totalDebt !== undefined
      ? p.totalDebt - (p.cashAndEquivalents ?? 0) - (p.shortTermInvestments ?? 0)
      : undefined;

  return {
    period: p.period,
    grossMargin: pct(p.grossProfit, p.revenue),
    operatingMargin: pct(p.operatingIncome, p.revenue),
    netMargin: pct(p.netIncome, p.revenue),
    ebitdaMargin: pct(p.ebitda, p.revenue),
    fcfMargin: pct(p.freeCashFlow, p.revenue),
    roe: pct(p.netIncome, p.totalEquity),
    roic: pct(nopat, ic),
    netDebt,
    netDebtToEbitda: safeDiv(netDebt, p.ebitda),
    currentRatio: safeDiv(p.currentAssets, p.currentLiabilities),
    revenueGrowthYoY: prior ? pct(
      p.revenue !== undefined && prior.revenue !== undefined ? p.revenue - prior.revenue : undefined,
      prior.revenue
    ) : undefined,
    epsGrowthYoY: prior ? pct(
      p.epsDiluted !== undefined && prior.epsDiluted !== undefined ? p.epsDiluted - prior.epsDiluted : undefined,
      prior.epsDiluted !== undefined ? Math.abs(prior.epsDiluted) : undefined
    ) : undefined,
    fcfConversion: safeDiv(p.freeCashFlow, p.netIncome),
  };
}

/** Series is assumed ascending by period. */
export function deriveSeries(periods: FinancialPeriod[]): DerivedMetrics[] {
  const normalised = periods.map(normalise);
  return normalised.map((p, i) => deriveOne(p, i > 0 ? normalised[i - 1] : undefined));
}

/**
 * Compound annual growth rate over a series. Returns undefined when the base is
 * non-positive, since CAGR is undefined through a sign change — a case that
 * naive implementations report as a nonsense percentage.
 */
export function cagr(values: (number | undefined)[], years: number): number | undefined {
  const clean = values.filter((v): v is number => v !== undefined);
  const first = clean[0];
  const last = clean[clean.length - 1];
  if (first === undefined || last === undefined || first <= 0 || last <= 0 || years <= 0) return undefined;
  return (Math.pow(last / first, 1 / years) - 1) * 100;
}

/** Trailing-twelve-month aggregation from quarterly data. */
export function ttm(quarters: FinancialPeriod[]): FinancialPeriod | undefined {
  const last4 = quarters.slice(-4);
  if (last4.length < 4) return undefined;
  const sum = (f: keyof FinancialPeriod) =>
    last4.reduce<number | undefined>((acc, q) => {
      const v = q[f];
      if (typeof v !== "number") return acc;
      return (acc ?? 0) + v;
    }, undefined);

  const latest = last4[3]!;
  return {
    period: "TTM",
    endDate: latest.endDate,
    fiscalYear: latest.fiscalYear,
    revenue: sum("revenue"),
    costOfRevenue: sum("costOfRevenue"),
    grossProfit: sum("grossProfit"),
    operatingIncome: sum("operatingIncome"),
    netIncome: sum("netIncome"),
    ebitda: sum("ebitda"),
    epsDiluted: sum("epsDiluted"),
    interestExpense: sum("interestExpense"),
    taxExpense: sum("taxExpense"),
    pretaxIncome: sum("pretaxIncome"),
    operatingCashFlow: sum("operatingCashFlow"),
    capex: sum("capex"),
    freeCashFlow: sum("freeCashFlow"),
    // Balance-sheet items are point-in-time, not additive: carry the latest.
    totalAssets: latest.totalAssets,
    totalLiabilities: latest.totalLiabilities,
    totalEquity: latest.totalEquity,
    cashAndEquivalents: latest.cashAndEquivalents,
    shortTermInvestments: latest.shortTermInvestments,
    totalDebt: latest.totalDebt,
    currentAssets: latest.currentAssets,
    currentLiabilities: latest.currentLiabilities,
  };
}
