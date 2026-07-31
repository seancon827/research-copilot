"use client";

import clsx from "clsx";
import { direction, money, price, signedPercent } from "@/lib/format";
import { Pill, Skeleton } from "./primitives";
import type { CompanyProfile, Quote } from "@/lib/types";
import type * as S from "@/lib/ai/schemas";

/**
 * The header is the page's thesis statement: identity, price, and the one thing
 * the reader wants first — the rating with its confidence. The rating is
 * deliberately rendered in the inference palette, because it is an opinion
 * sitting next to facts and should not be mistaken for one.
 */
export function CompanyHeader({
  profile,
  quote,
  recommendation,
  loading,
}: {
  profile?: CompanyProfile;
  quote?: Quote;
  recommendation?: S.Recommendation;
  loading: boolean;
}) {
  if (!profile) {
    return (
      <div className="border-b border-term-line bg-term-panel">
        <Skeleton rows={2} label={loading ? "resolving ticker" : undefined} />
      </div>
    );
  }

  const ratingTone =
    recommendation?.rating === "buy" ? "up" : recommendation?.rating === "sell" ? "down" : "fact";

  return (
    <header className="border-b border-term-line bg-term-panel">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2.5">
            <span className="font-mono text-xl font-semibold tracking-tight text-fact">{profile.ticker}</span>
            <h1 className="truncate text-sm text-term-bright">{profile.name}</h1>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-2xs text-term-dim">
            <span>{profile.exchange ?? "—"}</span>
            <span aria-hidden>·</span>
            <span>{profile.industry ?? profile.sector ?? "industry not disclosed"}</span>
            {profile.marketCap && (
              <>
                <span aria-hidden>·</span>
                <span>mkt cap {money(profile.marketCap)}</span>
              </>
            )}
          </p>
        </div>

        <div className="text-right">
          <div className="font-mono text-2xl tabular-nums text-term-bright">{price(quote?.price)}</div>
          <div className={clsx("font-mono text-xs tabular-nums", direction(quote?.change))}>
            {quote ? `${quote.change >= 0 ? "+" : ""}${quote.change.toFixed(2)}` : "—"}{" "}
            {signedPercent(quote?.changePercent)}
          </div>
        </div>

        {recommendation ? (
          <div className="border-l border-term-line pl-5">
            <div className="label">Model rating</div>
            <div className="mt-1 flex items-center gap-2">
              <Pill tone={ratingTone}>{recommendation.rating}</Pill>
              <span className="font-mono text-xs text-infer">{recommendation.confidence}% conf</span>
            </div>
            <div className="mt-1 font-mono text-2xs text-term-dim">{recommendation.horizon}</div>
          </div>
        ) : (
          <div className="border-l border-term-line pl-5">
            <div className="label">Model rating</div>
            <div className="mt-1 font-mono text-xs text-term-dim animate-pulse-line">
              {loading ? "analysing…" : "not generated"}
            </div>
          </div>
        )}
      </div>

      {quote?.fiftyTwoWeekHigh && quote.fiftyTwoWeekLow && (
        <FiftyTwoWeekBar low={quote.fiftyTwoWeekLow} high={quote.fiftyTwoWeekHigh} current={quote.price} />
      )}
    </header>
  );
}

/** Where the price sits in its annual range, as a single hairline. */
function FiftyTwoWeekBar({ low, high, current }: { low: number; high: number; current: number }) {
  const span = high - low;
  const position = span > 0 ? Math.min(100, Math.max(0, ((current - low) / span) * 100)) : 50;

  return (
    <div className="flex items-center gap-3 border-t border-term-line px-4 py-1.5">
      <span className="font-mono text-2xs text-term-dim">{low.toFixed(2)}</span>
      <div className="relative h-[3px] flex-1 rounded-full bg-term-raised">
        <div className="absolute inset-y-0 left-0 rounded-full bg-fact/25" style={{ width: `${position}%` }} />
        <div
          className="absolute top-1/2 h-2 w-[2px] -translate-y-1/2 bg-fact"
          style={{ left: `${position}%` }}
          aria-hidden
        />
      </div>
      <span className="font-mono text-2xs text-term-dim">{high.toFixed(2)}</span>
      <span className="label">52w range</span>
    </div>
  );
}
