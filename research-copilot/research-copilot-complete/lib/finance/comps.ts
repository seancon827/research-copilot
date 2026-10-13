import type { FinancialPeriod } from "../types";

/**
 * Relative valuation.
 *
 * Multiples are quoted against TTM figures, and we use the *median* peer
 * multiple rather than the mean: peer sets are small and one loss-making or
 * recently-acquired comparable will drag a mean far enough to make the output
 * meaningless.
 */

export interface Multiples {
  ticker: string;
  marketCap?: number;
  enterpriseValue?: number;
  pe?: number;
  evEbitda?: number;
  evSales?: number;
  priceToFcf?: number;
  /** Fields we could not compute, so the UI can show gaps instead of blanks. */
  unavailable: string[];
}

export function computeMultiples(
  ticker: string,
  ttm: FinancialPeriod | undefined,
  marketCap: number | undefined,
  price: number | undefined
): Multiples {
  const unavailable: string[] = [];
  const netDebt =
    ttm?.totalDebt !== undefined
      ? ttm.totalDebt - (ttm.cashAndEquivalents ?? 0) - (ttm.shortTermInvestments ?? 0)
      : undefined;
  const ev = marketCap !== undefined && netDebt !== undefined ? marketCap + netDebt : undefined;

  const ratio = (num?: number, den?: number, label?: string): number | undefined => {
    if (num === undefined || den === undefined || den <= 0) {
      if (label) unavailable.push(label);
      return undefined;
    }
    return num / den;
  };

  return {
    ticker: ticker.toUpperCase(),
    marketCap,
    enterpriseValue: ev,
    // A negative-earnings P/E is not "cheap", it is undefined. The `den <= 0`
    // guard is the difference between a useful screen and a misleading one.
    pe: ratio(price, ttm?.epsDiluted, "P/E (negative or missing EPS)"),
    evEbitda: ratio(ev, ttm?.ebitda, "EV/EBITDA (negative or missing EBITDA)"),
    evSales: ratio(ev, ttm?.revenue, "EV/Sales"),
    priceToFcf: ratio(marketCap, ttm?.freeCashFlow, "P/FCF (negative or missing FCF)"),
    unavailable,
  };
}

export function median(values: (number | undefined)[]): number | undefined {
  const clean = values.filter((v): v is number => v !== undefined && Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (clean.length === 0) return undefined;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid]! : (clean[mid - 1]! + clean[mid]!) / 2;
}

export interface RelativeValuation {
  peerMedianPe?: number;
  peerMedianEvEbitda?: number;
  impliedPriceFromPe?: number;
  impliedPriceFromEvEbitda?: number;
  peerCount: number;
  note: string;
}

export function relativeValuation(
  subject: Multiples,
  subjectTtm: FinancialPeriod | undefined,
  peers: Multiples[]
): RelativeValuation {
  const peerMedianPe = median(peers.map((p) => p.pe));
  const peerMedianEvEbitda = median(peers.map((p) => p.evEbitda));

  const impliedPriceFromPe =
    peerMedianPe !== undefined && subjectTtm?.epsDiluted !== undefined && subjectTtm.epsDiluted > 0
      ? peerMedianPe * subjectTtm.epsDiluted
      : undefined;

  // EV/EBITDA implies an enterprise value; back out equity per share.
  //
  // Share count is derived as net income / diluted EPS rather than taken from the
  // profile endpoint, because the two are often measured at different dates and
  // mixing them produces a per-share figure that reconciles with nothing.
  let impliedPriceFromEvEbitda: number | undefined;
  if (peerMedianEvEbitda !== undefined && subjectTtm?.ebitda !== undefined && subjectTtm.ebitda > 0) {
    const impliedEv = peerMedianEvEbitda * subjectTtm.ebitda;
    const netDebt =
      (subjectTtm.totalDebt ?? 0) - (subjectTtm.cashAndEquivalents ?? 0) - (subjectTtm.shortTermInvestments ?? 0);
    const impliedEquity = impliedEv - netDebt;

    const shares =
      subjectTtm.netIncome !== undefined && subjectTtm.epsDiluted !== undefined && subjectTtm.epsDiluted !== 0
        ? subjectTtm.netIncome / subjectTtm.epsDiluted
        : undefined;

    if (shares !== undefined && shares > 0) impliedPriceFromEvEbitda = impliedEquity / shares;
  }

  return {
    peerMedianPe,
    peerMedianEvEbitda,
    impliedPriceFromPe,
    impliedPriceFromEvEbitda,
    peerCount: peers.length,
    note:
      peers.length < 3
        ? "Fewer than three usable comparables. Treat the relative valuation as indicative only."
        : "Peer medians used to limit the effect of outliers.",
  };
}

/** Margin of safety against a reference value, in percent. */
export function marginOfSafety(price: number, intrinsic: number): number | undefined {
  if (!Number.isFinite(price) || !Number.isFinite(intrinsic) || intrinsic <= 0) return undefined;
  return ((intrinsic - price) / intrinsic) * 100;
}
