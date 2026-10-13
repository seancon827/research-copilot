"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Metric, Panel, SectionError, Skeleton } from "../primitives";
import { DASH, money, percent, price, ratio } from "@/lib/format";
import type { DerivedMetrics, EarningsEvent, FinancialPeriod } from "@/lib/types";

const AXIS = { stroke: "#5C6B7F", fontSize: 10, fontFamily: "var(--font-mono)" };
const GRID = "#1E2530";

const chartTooltip = {
  contentStyle: {
    background: "#10141B",
    border: "1px solid #1E2530",
    borderRadius: 2,
    fontFamily: "var(--font-mono)",
    fontSize: 11,
  },
  labelStyle: { color: "#EEF3F9" },
};

/** Compact axis labels: recharts will happily print 394328000000 otherwise. */
const compact = (v: number) => {
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${(v / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `${(v / 1e9).toFixed(0)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(0)}M`;
  return String(v);
};

export function FinancialsPanel({
  annual,
  derived,
  ttm,
  earnings,
  error,
  loading,
}: {
  annual?: FinancialPeriod[];
  derived?: DerivedMetrics[];
  ttm?: FinancialPeriod;
  earnings?: EarningsEvent[];
  error?: string;
  loading: boolean;
}) {
  if (error) return <Panel title="Financials"><SectionError section="Financials" message={error} /></Panel>;
  if (!annual?.length) {
    return (
      <Panel title="Financials">
        <Skeleton rows={5} label={loading ? "retrieving reported statements" : undefined} />
      </Panel>
    );
  }

  const latest = ttm ?? annual[annual.length - 1]!;
  const latestDerived = derived?.[derived.length - 1];

  const revenueSeries = annual.map((p, i) => ({
    period: p.period,
    revenue: p.revenue ?? null,
    fcf: p.freeCashFlow ?? null,
    growth: derived?.[i]?.revenueGrowthYoY ?? null,
  }));

  const marginSeries = (derived ?? []).map((d) => ({
    period: d.period,
    gross: d.grossMargin ?? null,
    operating: d.operatingMargin ?? null,
    net: d.netMargin ?? null,
  }));

  const returnSeries = (derived ?? []).map((d) => ({
    period: d.period,
    roic: d.roic ?? null,
    roe: d.roe ?? null,
  }));

  return (
    <div className="space-y-4">
      <Panel
        title="Headline figures"
        subtitle={`${latest.period} · ratios derived from as-reported statements, not vendor-supplied`}
      >
        <div className="grid grid-cols-2 border-t border-term-line sm:grid-cols-3 lg:grid-cols-5">
          <Metric label="Revenue" value={money(latest.revenue)} />
          <Metric label="EBITDA" value={money(latest.ebitda)} hint={latest.ebitda ? "approx: op. income basis" : undefined} />
          <Metric label="Operating margin" value={percent(latestDerived?.operatingMargin)} />
          <Metric label="Gross margin" value={percent(latestDerived?.grossMargin)} />
          <Metric label="Diluted EPS" value={price(latest.epsDiluted)} />
          <Metric label="Free cash flow" value={money(latest.freeCashFlow)} />
          <Metric label="Total debt" value={money(latest.totalDebt)} />
          <Metric
            label="Cash + ST inv."
            value={money((latest.cashAndEquivalents ?? 0) + (latest.shortTermInvestments ?? 0))}
          />
          <Metric
            label="ROIC"
            value={percent(latestDerived?.roic)}
            hint="NOPAT / (debt + equity − cash)"
          />
          <Metric label="ROE" value={percent(latestDerived?.roe)} hint="net income / equity" />
        </div>
      </Panel>

      <Panel title="Revenue & free cash flow" subtitle="Reported annual periods, with year-on-year revenue growth">
        <div className="h-64 p-3">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={revenueSeries}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="period" {...AXIS} tickLine={false} />
              <YAxis yAxisId="abs" tickFormatter={compact} {...AXIS} tickLine={false} width={48} />
              <YAxis
                yAxisId="pct"
                orientation="right"
                tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                {...AXIS}
                tickLine={false}
                width={40}
              />
              <Tooltip
                {...chartTooltip}
                formatter={(value: number, name: string) =>
                  name === "growth" ? percent(value) : money(value)
                }
              />
              <Legend wrapperStyle={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "#5C6B7F" }} />
              <Bar yAxisId="abs" dataKey="revenue" name="Revenue" fill="#F0A11B" fillOpacity={0.75} />
              <Bar yAxisId="abs" dataKey="fcf" name="Free cash flow" fill="#4CC9C0" fillOpacity={0.6} />
              <Line
                yAxisId="pct"
                type="monotone"
                dataKey="growth"
                name="Revenue growth %"
                stroke="#EEF3F9"
                strokeWidth={1.5}
                dot={{ r: 2 }}
                connectNulls
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Margin trend">
          <div className="h-56 p-3">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={marginSeries}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="period" {...AXIS} tickLine={false} />
                <YAxis tickFormatter={(v: number) => `${v.toFixed(0)}%`} {...AXIS} tickLine={false} width={40} />
                <Tooltip {...chartTooltip} formatter={(v: number) => percent(v)} />
                <Legend wrapperStyle={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "#5C6B7F" }} />
                <Line type="monotone" dataKey="gross" name="Gross" stroke="#F0A11B" strokeWidth={1.5} dot={false} connectNulls />
                <Line type="monotone" dataKey="operating" name="Operating" stroke="#4CC9C0" strokeWidth={1.5} dot={false} connectNulls />
                <Line type="monotone" dataKey="net" name="Net" stroke="#C9D4E2" strokeWidth={1.5} dot={false} connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Returns on capital" subtitle="ROIC above cost of capital is the test that matters">
          <div className="h-56 p-3">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={returnSeries}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="period" {...AXIS} tickLine={false} />
                <YAxis tickFormatter={(v: number) => `${v.toFixed(0)}%`} {...AXIS} tickLine={false} width={40} />
                <Tooltip {...chartTooltip} formatter={(v: number) => percent(v)} />
                <Legend wrapperStyle={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "#5C6B7F" }} />
                <Bar dataKey="roic" name="ROIC" fill="#F0A11B" fillOpacity={0.8} />
                <Bar dataKey="roe" name="ROE" fill="#4CC9C0" fillOpacity={0.6} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>

      <Panel title="Derived ratios by period" subtitle="Blank cells mean the input line was not reported, not zero">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-right">
            <thead>
              <tr className="border-b border-term-line">
                <th className="label px-3 py-2 text-left">Metric</th>
                {(derived ?? []).map((d) => (
                  <th key={d.period} className="label px-3 py-2">{d.period}</th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono text-xs tabular-nums">
              {(
                [
                  ["Gross margin", (d: DerivedMetrics) => percent(d.grossMargin)],
                  ["Operating margin", (d: DerivedMetrics) => percent(d.operatingMargin)],
                  ["Net margin", (d: DerivedMetrics) => percent(d.netMargin)],
                  ["FCF margin", (d: DerivedMetrics) => percent(d.fcfMargin)],
                  ["Revenue growth", (d: DerivedMetrics) => percent(d.revenueGrowthYoY)],
                  ["ROIC", (d: DerivedMetrics) => percent(d.roic)],
                  ["ROE", (d: DerivedMetrics) => percent(d.roe)],
                  ["Net debt / EBITDA", (d: DerivedMetrics) => ratio(d.netDebtToEbitda)],
                  ["Current ratio", (d: DerivedMetrics) => ratio(d.currentRatio)],
                  ["FCF / net income", (d: DerivedMetrics) => ratio(d.fcfConversion)],
                ] as const
              ).map(([label, fn]) => (
                <tr key={label} className="border-b border-term-line/60">
                  <th scope="row" className="px-3 py-1.5 text-left font-normal text-term-dim">{label}</th>
                  {(derived ?? []).map((d) => {
                    const v = fn(d);
                    return (
                      <td key={d.period} className={v === DASH ? "px-3 py-1.5 text-term-dim" : "px-3 py-1.5 text-fact"}>
                        {v}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {earnings?.length ? (
        <Panel title="Reported vs consensus EPS">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-right font-mono text-xs tabular-nums">
              <thead>
                <tr className="border-b border-term-line">
                  <th className="label px-3 py-2 text-left">Period</th>
                  <th className="label px-3 py-2">Reported</th>
                  <th className="label px-3 py-2">Consensus</th>
                  <th className="label px-3 py-2">Surprise</th>
                </tr>
              </thead>
              <tbody>
                {earnings.map((e) => (
                  <tr key={e.period} className="border-b border-term-line/60">
                    <td className="px-3 py-1.5 text-left text-term-dim">{e.period}</td>
                    <td className="px-3 py-1.5 text-fact">{price(e.epsActual)}</td>
                    <td className="px-3 py-1.5 text-term-text">{price(e.epsEstimate)}</td>
                    <td
                      className={
                        e.epsSurprisePercent === undefined
                          ? "px-3 py-1.5 text-term-dim"
                          : e.epsSurprisePercent >= 0
                            ? "px-3 py-1.5 text-up"
                            : "px-3 py-1.5 text-down"
                      }
                    >
                      {e.epsSurprisePercent === undefined
                        ? DASH
                        : `${e.epsSurprisePercent >= 0 ? "+" : ""}${e.epsSurprisePercent.toFixed(1)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
