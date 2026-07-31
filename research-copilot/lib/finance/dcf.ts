import type { FinancialPeriod } from "../types";
import { effectiveTaxRate } from "./metrics";

/**
 * Two-stage FCFF discounted cash flow.
 *
 * DESIGN DECISION: this is plain TypeScript, not a model call.
 *
 * A language model asked to "do a DCF" produces arithmetic that looks right and
 * is frequently wrong, and it cannot be audited. Here the model's only job is to
 * *propose and justify assumptions* (growth, margin path, terminal rate) and to
 * explain the output in prose. The arithmetic is deterministic, unit-tested and
 * reproducible: same inputs, same intrinsic value, every time. Every assumption
 * is returned alongside the result so the UI can show its provenance and let the
 * user override it.
 *
 * Model: enterprise value = Σ FCFF_t / (1+WACC)^t + TV / (1+WACC)^N
 *        equity value     = EV − net debt
 *        per share        = equity value / diluted shares
 */

export interface DcfAssumptions {
  /** Revenue growth per projection year, as decimals. Length sets the horizon. */
  revenueGrowth: number[];
  /** Target operating margin at the end of the projection, as a decimal. */
  terminalOperatingMargin: number;
  /** Capex as a share of revenue, decimal. */
  capexPctRevenue: number;
  /** Incremental change in net working capital as a share of incremental revenue. */
  nwcPctIncrementalRevenue: number;
  /** Effective cash tax rate, decimal. */
  taxRate: number;

  // --- WACC inputs (CAPM) ---
  riskFreeRate: number;
  equityRiskPremium: number;
  beta: number;
  /** Pre-tax cost of debt. */
  costOfDebt: number;

  /** Perpetuity growth rate. Must be < WACC or the model is undefined. */
  terminalGrowth: number;

  /** Balance-sheet inputs, absolute currency units. */
  netDebt: number;
  dilutedShares: number;
  marketCap: number;

  /** Where each assumption came from, for the UI. */
  provenance: Record<string, string>;
}

export interface ProjectionYear {
  year: number;
  revenue: number;
  operatingMargin: number;
  ebit: number;
  nopat: number;
  capex: number;
  changeInNwc: number;
  fcff: number;
  discountFactor: number;
  presentValue: number;
}

export interface DcfResult {
  assumptions: DcfAssumptions;
  wacc: number;
  costOfEquity: number;
  debtWeight: number;
  projections: ProjectionYear[];
  pvOfProjections: number;
  terminalValue: number;
  pvOfTerminalValue: number;
  /** Share of total value in the terminal period — a key credibility check. */
  terminalValueShare: number;
  enterpriseValue: number;
  equityValue: number;
  intrinsicValuePerShare: number;
  /** Sensitivity of per-share value to WACC (rows) and terminal growth (cols). */
  sensitivity: { waccs: number[]; growths: number[]; grid: number[][] };
  warnings: string[];
}

/** Weighted average cost of capital via CAPM on the equity leg. */
export function computeWacc(a: DcfAssumptions): { wacc: number; costOfEquity: number; debtWeight: number } {
  const costOfEquity = a.riskFreeRate + a.beta * a.equityRiskPremium;

  // Use gross debt for capital-structure weights. Net debt can be negative for
  // cash-rich companies, which would produce a negative debt weight and an
  // understated WACC.
  const grossDebt = Math.max(0, a.netDebt);
  const totalCapital = a.marketCap + grossDebt;
  const debtWeight = totalCapital > 0 ? grossDebt / totalCapital : 0;
  const equityWeight = 1 - debtWeight;

  const wacc = equityWeight * costOfEquity + debtWeight * a.costOfDebt * (1 - a.taxRate);
  return { wacc, costOfEquity, debtWeight };
}

export function runDcf(baseRevenue: number, baseOperatingMargin: number, a: DcfAssumptions): DcfResult {
  const warnings: string[] = [];
  const { wacc, costOfEquity, debtWeight } = computeWacc(a);

  if (a.terminalGrowth >= wacc) {
    warnings.push(
      `Terminal growth (${(a.terminalGrowth * 100).toFixed(1)}%) is not below WACC (${(wacc * 100).toFixed(
        1
      )}%). The Gordon growth model is undefined here; terminal growth was capped at WACC − 50bps.`
    );
  }
  const g = Math.min(a.terminalGrowth, wacc - 0.005);

  const horizon = a.revenueGrowth.length;
  const projections: ProjectionYear[] = [];

  let revenue = baseRevenue;
  let priorRevenue = baseRevenue;

  for (let t = 1; t <= horizon; t++) {
    const growth = a.revenueGrowth[t - 1] ?? 0;
    priorRevenue = revenue;
    revenue = revenue * (1 + growth);

    // Linearly glide the operating margin from today's level to the terminal
    // target. A step change would put an unjustified discontinuity in year 1.
    const progress = t / horizon;
    const operatingMargin = baseOperatingMargin + (a.terminalOperatingMargin - baseOperatingMargin) * progress;

    const ebit = revenue * operatingMargin;
    const nopat = ebit * (1 - a.taxRate);
    const capex = revenue * a.capexPctRevenue;
    const changeInNwc = (revenue - priorRevenue) * a.nwcPctIncrementalRevenue;

    // FCFF = NOPAT + D&A − capex − ΔNWC. We fold D&A into the capex ratio
    // (steady-state assumption: D&A ≈ maintenance capex), so the term drops out.
    // Stated in the assumptions panel because it matters for capital-intensive
    // businesses where the two diverge.
    const fcff = nopat - capex - changeInNwc;

    const discountFactor = 1 / Math.pow(1 + wacc, t);
    projections.push({
      year: t,
      revenue,
      operatingMargin,
      ebit,
      nopat,
      capex,
      changeInNwc,
      fcff,
      discountFactor,
      presentValue: fcff * discountFactor,
    });
  }

  const pvOfProjections = projections.reduce((s, p) => s + p.presentValue, 0);

  const finalYear = projections[projections.length - 1];
  if (!finalYear) throw new Error("DCF requires at least one projection year");

  const terminalFcff = finalYear.fcff * (1 + g);
  const terminalValue = terminalFcff / (wacc - g);
  const pvOfTerminalValue = terminalValue * finalYear.discountFactor;

  const enterpriseValue = pvOfProjections + pvOfTerminalValue;
  const equityValue = enterpriseValue - a.netDebt;
  const intrinsicValuePerShare = a.dilutedShares > 0 ? equityValue / a.dilutedShares : 0;

  const terminalValueShare = enterpriseValue !== 0 ? pvOfTerminalValue / enterpriseValue : 0;
  if (terminalValueShare > 0.8) {
    warnings.push(
      `${(terminalValueShare * 100).toFixed(
        0
      )}% of enterprise value sits in the terminal period. The output is driven mainly by the perpetuity assumption, not the forecast.`
    );
  }
  if (equityValue < 0) {
    warnings.push("Equity value is negative: net debt exceeds the present value of forecast cash flows.");
  }

  return {
    assumptions: { ...a, terminalGrowth: g },
    wacc,
    costOfEquity,
    debtWeight,
    projections,
    pvOfProjections,
    terminalValue,
    pvOfTerminalValue,
    terminalValueShare,
    enterpriseValue,
    equityValue,
    intrinsicValuePerShare,
    sensitivity: buildSensitivity(baseRevenue, baseOperatingMargin, a, wacc, g),
    warnings,
  };
}

/**
 * A single DCF output is a point estimate with false precision. The grid is the
 * honest presentation: it shows how much of the answer is the analyst's choice
 * of discount rate versus anything about the business.
 */
function buildSensitivity(
  baseRevenue: number,
  baseMargin: number,
  a: DcfAssumptions,
  centreWacc: number,
  centreGrowth: number
): DcfResult["sensitivity"] {
  const waccs = [-0.02, -0.01, 0, 0.01, 0.02].map((d) => Math.max(0.02, centreWacc + d));
  const growths = [-0.01, -0.005, 0, 0.005, 0.01].map((d) => Math.max(0, centreGrowth + d));

  const grid = waccs.map((w) =>
    growths.map((gr) => {
      const g = Math.min(gr, w - 0.005);
      let revenue = baseRevenue;
      let prior = baseRevenue;
      let pv = 0;
      let lastFcff = 0;
      let lastDf = 1;

      for (let t = 1; t <= a.revenueGrowth.length; t++) {
        prior = revenue;
        revenue *= 1 + (a.revenueGrowth[t - 1] ?? 0);
        const margin = baseMargin + (a.terminalOperatingMargin - baseMargin) * (t / a.revenueGrowth.length);
        const fcff =
          revenue * margin * (1 - a.taxRate) -
          revenue * a.capexPctRevenue -
          (revenue - prior) * a.nwcPctIncrementalRevenue;
        const df = 1 / Math.pow(1 + w, t);
        pv += fcff * df;
        lastFcff = fcff;
        lastDf = df;
      }

      const tv = (lastFcff * (1 + g)) / (w - g);
      const equity = pv + tv * lastDf - a.netDebt;
      return a.dilutedShares > 0 ? equity / a.dilutedShares : 0;
    })
  );

  return { waccs, growths, grid };
}

/**
 * Build a defensible default assumption set from history, so the DCF is
 * grounded in reported numbers before the model or user touches anything.
 * Each choice records where it came from.
 */
export function defaultAssumptions(input: {
  annual: FinancialPeriod[];
  ttmPeriod?: FinancialPeriod;
  marketCap: number;
  dilutedShares: number;
  beta?: number;
  riskFreeRate?: number;
}): DcfAssumptions | null {
  const history = input.annual.filter((p) => p.revenue !== undefined);
  const latest = input.ttmPeriod ?? history[history.length - 1];
  if (!latest?.revenue) return null;

  const provenance: Record<string, string> = {};

  // Historical revenue CAGR, damped toward GDP-like growth over the horizon.
  const first = history[0];
  const years = history.length - 1;
  let historicCagr = 0.05;
  if (first?.revenue && years > 0 && first.revenue > 0 && latest.revenue > 0) {
    historicCagr = Math.pow(latest.revenue / first.revenue, 1 / years) - 1;
    provenance.revenueGrowth = `${years}y reported revenue CAGR (${(historicCagr * 100).toFixed(
      1
    )}%), damped linearly toward 3% by year 5`;
  } else {
    provenance.revenueGrowth = "Default 5% fading to 3% (insufficient reported history)";
  }
  const start = Math.max(-0.1, Math.min(0.35, historicCagr)); // clamp outliers
  const revenueGrowth = Array.from({ length: 5 }, (_, i) => start + ((0.03 - start) * (i + 1)) / 5);

  const baseMargin =
    latest.operatingIncome !== undefined && latest.revenue
      ? latest.operatingIncome / latest.revenue
      : 0.1;
  provenance.terminalOperatingMargin = `Held at the latest reported operating margin (${(
    baseMargin * 100
  ).toFixed(1)}%); no expansion assumed`;

  const capexPctRevenue =
    latest.capex !== undefined && latest.revenue ? Math.abs(latest.capex) / latest.revenue : 0.04;
  provenance.capexPctRevenue = `Latest reported capex / revenue (${(capexPctRevenue * 100).toFixed(1)}%)`;

  const taxRate = effectiveTaxRate(latest);
  provenance.taxRate = `Effective rate from reported tax expense / pre-tax income (${(taxRate * 100).toFixed(
    1
  )}%)`;

  const netDebt =
    (latest.totalDebt ?? 0) - (latest.cashAndEquivalents ?? 0) - (latest.shortTermInvestments ?? 0);
  provenance.netDebt = "Reported total debt less cash and short-term investments";

  const riskFreeRate = input.riskFreeRate ?? 0.043;
  provenance.riskFreeRate = input.riskFreeRate
    ? "Live 10y Treasury yield"
    : "Static 4.3% placeholder — override for a live yield";
  provenance.equityRiskPremium = "Static 5.0% (Damodaran-style mature-market premium)";
  provenance.beta = input.beta ? "Vendor-reported beta" : "Assumed 1.0 (no beta available)";
  provenance.terminalGrowth = "2.5%, below long-run nominal GDP";
  provenance.nwcPctIncrementalRevenue = "Assumed 2% of incremental revenue";
  provenance.costOfDebt = "Assumed 5.5% pre-tax";

  return {
    revenueGrowth,
    terminalOperatingMargin: baseMargin,
    capexPctRevenue,
    nwcPctIncrementalRevenue: 0.02,
    taxRate,
    riskFreeRate,
    equityRiskPremium: 0.05,
    beta: input.beta ?? 1.0,
    costOfDebt: 0.055,
    terminalGrowth: 0.025,
    netDebt,
    dilutedShares: input.dilutedShares,
    marketCap: input.marketCap,
    provenance,
  };
}
