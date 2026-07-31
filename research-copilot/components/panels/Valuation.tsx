"use client";

import clsx from "clsx";
import { ClaimLine, Metric, Panel, Pill, SectionError, Skeleton } from "../primitives";
import { DASH, money, multiple, percent, price } from "@/lib/format";
import type { ResearchState } from "@/lib/useResearchStream";
import type { DcfResult } from "@/lib/finance/dcf";

export function ValuationPanel({ state }: { state: ResearchState }) {
  const err = state.sectionErrors.valuation;
  if (err) return <Panel title="Valuation"><SectionError section="Valuation" message={err} /></Panel>;
  if (!state.valuation) {
    return <Panel title="Valuation"><Skeleton rows={5} label={state.stages.valuation === "running" ? "running the model" : undefined} /></Panel>;
  }

  const { dcf, subject, peers, relative, currentPrice, marginOfSafetyPercent } = state.valuation;
  const mos = marginOfSafetyPercent;

  return (
    <div className="space-y-4">
      <Panel
        title="Discounted cash flow"
        subtitle="Computed in application code, not by the model. Same inputs always produce the same output."
        action={<Pill tone="fact">deterministic</Pill>}
      >
        <div className="grid grid-cols-2 border-t border-term-line sm:grid-cols-4">
          <Metric label="Intrinsic value / share" value={price(dcf.intrinsicValuePerShare)} />
          <Metric label="Current price" value={price(currentPrice)} tone="neutral" />
          <Metric
            label="Margin of safety"
            value={mos === undefined ? DASH : percent(mos)}
            tone={mos === undefined ? "neutral" : mos > 0 ? "up" : "down"}
            hint="(intrinsic − price) / intrinsic"
          />
          <Metric label="WACC" value={percent(dcf.wacc * 100, 2)} hint={`CAPM · beta ${dcf.assumptions.beta.toFixed(2)}`} />
          <Metric label="Enterprise value" value={money(dcf.enterpriseValue)} />
          <Metric label="Equity value" value={money(dcf.equityValue)} />
          <Metric label="Terminal growth" value={percent(dcf.assumptions.terminalGrowth * 100, 2)} />
          <Metric
            label="Value in terminal period"
            value={percent(dcf.terminalValueShare * 100, 0)}
            tone={dcf.terminalValueShare > 0.8 ? "down" : "fact"}
            hint={dcf.terminalValueShare > 0.8 ? "assumption-driven" : "acceptable"}
          />
        </div>

        {dcf.warnings.length > 0 && (
          <div className="border-t border-term-line bg-down/5 px-4 py-2.5">
            {dcf.warnings.map((w) => (
              <p key={w} className="font-mono text-2xs leading-relaxed text-down">
                ⚠ {w}
              </p>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Free cash flow projection" subtitle="Operating margin glides linearly to the terminal target">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-right font-mono text-xs tabular-nums">
            <thead>
              <tr className="border-b border-term-line">
                <th className="label px-3 py-2 text-left">Year</th>
                <th className="label px-3 py-2">Revenue</th>
                <th className="label px-3 py-2">Op. margin</th>
                <th className="label px-3 py-2">NOPAT</th>
                <th className="label px-3 py-2">Capex</th>
                <th className="label px-3 py-2">FCFF</th>
                <th className="label px-3 py-2">PV</th>
              </tr>
            </thead>
            <tbody>
              {dcf.projections.map((p) => (
                <tr key={p.year} className="border-b border-term-line/60">
                  <td className="px-3 py-1.5 text-left text-term-dim">Y{p.year}</td>
                  <td className="px-3 py-1.5 text-term-text">{money(p.revenue)}</td>
                  <td className="px-3 py-1.5 text-term-text">{percent(p.operatingMargin * 100)}</td>
                  <td className="px-3 py-1.5 text-term-text">{money(p.nopat)}</td>
                  <td className="px-3 py-1.5 text-term-dim">({money(p.capex)})</td>
                  <td className="px-3 py-1.5 text-fact">{money(p.fcff)}</td>
                  <td className="px-3 py-1.5 text-fact">{money(p.presentValue)}</td>
                </tr>
              ))}
              <tr className="border-t border-term-line">
                <td colSpan={5} className="px-3 py-1.5 text-left text-term-dim">
                  PV of terminal value
                </td>
                <td className="px-3 py-1.5 text-term-dim">{money(dcf.terminalValue)}</td>
                <td className="px-3 py-1.5 text-fact">{money(dcf.pvOfTerminalValue)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>

      <SensitivityGrid dcf={dcf} currentPrice={currentPrice} />

      <Panel title="Assumptions & provenance" subtitle="Every input, and where it came from">
        <ul className="divide-y divide-term-line">
          {Object.entries(dcf.assumptions.provenance).map(([k, v]) => (
            <li key={k} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2">
              <span className="font-mono text-xs text-fact">{k}</span>
              <span className="font-mono text-2xs text-term-dim">{v}</span>
            </li>
          ))}
        </ul>
      </Panel>

      {state.valuationCommentary && (
        <Panel title="Assumption critique" subtitle="Model assessment of inputs it did not compute">
          <ul className="divide-y divide-term-line">
            {state.valuationCommentary.data.assumptionCritique.map((c, i) => (
              <li key={i} className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-term-bright">{c.assumption}</span>
                  <Pill tone={c.assessment === "aggressive" ? "down" : c.assessment === "conservative" ? "up" : "neutral"}>
                    {c.assessment}
                  </Pill>
                </div>
                <ul className="mt-1">
                  <ClaimLine text={c.reasoning} citations={c.citations} />
                </ul>
              </li>
            ))}
          </ul>
          <div className="border-t border-term-line px-4 py-3">
            <p className="label">Key swing factor</p>
            <p className="prose-ai mt-1">{state.valuationCommentary.data.keySwingFactor}</p>
          </div>
        </Panel>
      )}

      <Panel
        title="Comparables"
        subtitle={relative.note}
      >
        <div className="grid grid-cols-2 border-t border-term-line sm:grid-cols-4">
          <Metric label="P/E" value={multiple(subject.pe)} />
          <Metric label="EV/EBITDA" value={multiple(subject.evEbitda)} />
          <Metric label="EV/Sales" value={multiple(subject.evSales)} />
          <Metric label="P/FCF" value={multiple(subject.priceToFcf)} />
          <Metric label="Peer median P/E" value={multiple(relative.peerMedianPe)} hint={`${relative.peerCount} peers`} />
          <Metric label="Peer median EV/EBITDA" value={multiple(relative.peerMedianEvEbitda)} />
          <Metric label="Implied price (P/E)" value={price(relative.impliedPriceFromPe)} />
          <Metric label="Implied price (EV/EBITDA)" value={price(relative.impliedPriceFromEvEbitda)} />
        </div>

        {subject.unavailable.length > 0 && (
          <div className="border-t border-term-line px-4 py-2">
            <p className="font-mono text-2xs text-term-dim">
              Not computable: {subject.unavailable.join("; ")}
            </p>
          </div>
        )}

        {peers.length > 0 && (
          <div className="overflow-x-auto border-t border-term-line">
            <table className="w-full border-collapse text-right font-mono text-xs tabular-nums">
              <thead>
                <tr className="border-b border-term-line">
                  <th className="label px-3 py-2 text-left">Peer</th>
                  <th className="label px-3 py-2">Mkt cap</th>
                  <th className="label px-3 py-2">P/E</th>
                  <th className="label px-3 py-2">EV/EBITDA</th>
                  <th className="label px-3 py-2">EV/Sales</th>
                </tr>
              </thead>
              <tbody>
                {peers.map((p) => (
                  <tr key={p.ticker} className="border-b border-term-line/60">
                    <td className="px-3 py-1.5 text-left text-fact">{p.ticker}</td>
                    <td className="px-3 py-1.5 text-term-text">{money(p.marketCap)}</td>
                    <td className="px-3 py-1.5 text-term-text">{multiple(p.pe)}</td>
                    <td className="px-3 py-1.5 text-term-text">{multiple(p.evEbitda)}</td>
                    <td className="px-3 py-1.5 text-term-text">{multiple(p.evSales)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

/**
 * The sensitivity grid is the most honest thing on the page: it shows that a
 * 100bps move in the discount rate changes the "intrinsic value" more than most
 * operational assumptions do. Cells are tinted against the current price so the
 * reader can see immediately which corner of assumption space implies upside.
 */
function SensitivityGrid({
  dcf,
  currentPrice,
}: {
  dcf: DcfResult;
  currentPrice?: number;
}) {
  const { waccs, growths, grid } = dcf.sensitivity;
  const flat = grid.flat();
  const min = Math.min(...flat);
  const max = Math.max(...flat);

  return (
    <Panel
      title="Sensitivity"
      subtitle="Intrinsic value per share across discount rate and terminal growth"
      action={currentPrice ? <span className="label">current {price(currentPrice)}</span> : undefined}
    >
      <div className="overflow-x-auto p-3">
        <table className="w-full min-w-[520px] border-collapse text-center font-mono text-xs tabular-nums">
          <thead>
            <tr>
              <th className="label px-2 py-1 text-left">WACC ↓ / g →</th>
              {growths.map((g) => (
                <th key={g} className="label px-2 py-1">{(g * 100).toFixed(2)}%</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.map((row, i) => (
              <tr key={i}>
                <th scope="row" className="label px-2 py-1 text-left">{((waccs[i] ?? 0) * 100).toFixed(2)}%</th>
                {row.map((cell, j) => {
                  const abovePrice = currentPrice !== undefined && cell > currentPrice;
                  // Intensity encodes position within the grid's own range, so the
                  // shading is readable regardless of the absolute share price.
                  const t = max > min ? (cell - min) / (max - min) : 0.5;
                  return (
                    <td
                      key={j}
                      className={clsx(
                        "border border-term-line px-2 py-1.5",
                        abovePrice ? "text-up" : "text-term-text"
                      )}
                      style={{
                        background: abovePrice
                          ? `rgba(63, 191, 127, ${0.06 + t * 0.18})`
                          : `rgba(240, 85, 78, ${0.06 + (1 - t) * 0.14})`,
                      }}
                    >
                      {cell.toFixed(2)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-term-line px-4 py-2 font-mono text-2xs leading-relaxed text-term-dim">
        Green cells sit above the current price. The spread across this grid is the honest confidence interval on the
        point estimate above.
      </p>
    </Panel>
  );
}
