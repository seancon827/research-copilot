"use client";

import clsx from "clsx";
import { Cite, ClaimLine, Panel, Pill, SectionError, Skeleton } from "../primitives";
import { percent } from "@/lib/format";
import type { ResearchState } from "@/lib/useResearchStream";

/**
 * Every panel here renders model output, so all of it lives in the inference
 * palette and carries citation chips. The `notDisclosed` / `evidenceGaps` lists
 * are given equal visual weight to the findings — an analyst needs to know what
 * the model could not establish just as much as what it could.
 */

function Gaps({ items, title }: { items: string[]; title: string }) {
  if (items.length === 0) return null;
  return (
    <div className="border-t border-term-line bg-term-bg/40 px-4 py-3">
      <p className="label text-fact">{title}</p>
      <ul className="mt-1.5 space-y-1">
        {items.map((item) => (
          <li key={item} className="font-mono text-2xs leading-relaxed text-term-dim">
            · {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function OverviewPanel({ state }: { state: ResearchState }) {
  const err = state.sectionErrors.overview;
  if (err) return <Panel title="Company overview"><SectionError section="Overview" message={err} /></Panel>;
  if (!state.overview) {
    return (
      <Panel title="Company overview">
        <Skeleton rows={4} label={state.stages.overview === "running" ? "writing overview" : undefined} />
      </Panel>
    );
  }

  const o = state.overview.data;

  return (
    <Panel title="Company overview" subtitle={`${state.overview.data.industry} · model-written, evidence-bounded`}>
      <div className="space-y-4 p-4">
        <p className="prose-ai">{o.businessSummary}</p>

        {o.products.length > 0 && (
          <div>
            <p className="label mb-1.5">Products & services</p>
            <ul className="space-y-1">
              {o.products.map((p) => (
                <ClaimLine key={p.name} text={`${p.name} — ${p.description}`} citations={p.citations} />
              ))}
            </ul>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Split title="Revenue mix" rows={o.revenueBreakdown.map((r) => ({ name: r.segment, share: r.sharePercent, citations: r.citations }))} />
          <Split title="Geographic exposure" rows={o.geographicExposure.map((g) => ({ name: g.region, share: g.sharePercent, citations: g.citations }))} />
        </div>

        {o.competitors.length > 0 && (
          <div>
            <p className="label mb-1.5">Competitive set</p>
            <ul className="space-y-1">
              {o.competitors.map((c) => (
                <ClaimLine key={c.name} text={`${c.name} — ${c.basisOfCompetition}`} />
              ))}
            </ul>
          </div>
        )}

        {o.management.length > 0 && (
          <div>
            <p className="label mb-1.5">Management</p>
            <ul className="space-y-1">
              {o.management.map((m) => (
                <ClaimLine key={`${m.name}-${m.role}`} text={`${m.name}, ${m.role}`} citations={m.citations} />
              ))}
            </ul>
          </div>
        )}
      </div>
      <Gaps items={o.notDisclosed} title="Not disclosed in retrieved evidence" />
    </Panel>
  );
}

function Split({
  title,
  rows,
}: {
  title: string;
  rows: { name: string; share: number | null; citations?: string[] }[];
}) {
  return (
    <div>
      <p className="label mb-1.5">{title}</p>
      {rows.length === 0 ? (
        <p className="font-mono text-2xs text-term-dim">Not disclosed in retrieved evidence.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r) => (
            <li key={r.name}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm text-term-text">
                  {r.name}
                  <Cite ids={r.citations ?? []} />
                </span>
                <span className={clsx("font-mono text-xs tabular-nums", r.share === null ? "text-term-dim" : "text-fact")}>
                  {r.share === null ? "not disclosed" : `${r.share.toFixed(0)}%`}
                </span>
              </div>
              {r.share !== null && (
                <div className="mt-1 h-[3px] rounded-full bg-term-raised">
                  <div className="h-full rounded-full bg-fact/60" style={{ width: `${Math.min(100, r.share)}%` }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SentimentPanel({ state }: { state: ResearchState }) {
  const err = state.sectionErrors.sentiment;
  if (err) return <Panel title="Sentiment"><SectionError section="Sentiment" message={err} /></Panel>;
  if (!state.sentiment) {
    return <Panel title="Sentiment"><Skeleton rows={3} label={state.stages.sentiment === "running" ? "scoring channels" : undefined} /></Panel>;
  }

  const { composite, data } = state.sentiment;

  return (
    <Panel title="Sentiment" subtitle={composite.method}>
      <div className="p-4">
        <div className="flex items-center gap-3">
          <Pill tone={composite.overall === "bullish" ? "up" : composite.overall === "bearish" ? "down" : "neutral"}>
            {composite.overall}
          </Pill>
          <span className="font-mono text-xs text-infer">{composite.confidence}% confidence</span>
        </div>

        <div className="mt-3 flex h-2 overflow-hidden rounded-sm bg-term-raised" role="img" aria-label={`Bullish ${composite.bullishScore}, bearish ${composite.bearishScore}`}>
          <div className="bg-up/70" style={{ width: `${composite.bullishScore}%` }} />
          <div className="bg-down/70" style={{ width: `${composite.bearishScore}%` }} />
        </div>
        <div className="mt-1 flex justify-between font-mono text-2xs">
          <span className="text-up">bullish {composite.bullishScore}</span>
          <span className="text-down">bearish {composite.bearishScore}</span>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-px border border-term-line bg-term-line">
          {(
            [
              ["Filings", composite.channels.filings, "40% weight"],
              ["Earnings", composite.channels.earnings, "35% weight"],
              ["News", composite.channels.news, "25%, importance-weighted"],
            ] as const
          ).map(([label, score, hint]) => (
            <div key={label} className="bg-term-panel px-3 py-2">
              <div className="label">{label}</div>
              <div className={clsx("mt-0.5 font-mono text-sm tabular-nums", score > 0.15 ? "text-up" : score < -0.15 ? "text-down" : "text-term-dim")}>
                {score >= 0 ? "+" : ""}
                {score.toFixed(2)}
              </div>
              <div className="mt-0.5 font-mono text-2xs text-term-dim">{hint}</div>
            </div>
          ))}
        </div>

        {data.rationale.length > 0 && (
          <ul className="mt-4 space-y-1">
            {data.rationale.map((c, i) => (
              <ClaimLine key={i} text={c.text} citations={c.citations} />
            ))}
          </ul>
        )}

        {data.contradictorySignals.length > 0 && (
          <div className="mt-4 border-l-2 border-l-fact/60 pl-3">
            <p className="label text-fact">Signals against this read</p>
            <ul className="mt-1 space-y-1">
              {data.contradictorySignals.map((c, i) => (
                <ClaimLine key={i} text={c.text} citations={c.citations} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </Panel>
  );
}

export function ThesisPanel({ state }: { state: ResearchState }) {
  const err = state.sectionErrors.thesis;
  if (err) return <Panel title="Investment thesis"><SectionError section="Thesis" message={err} /></Panel>;
  if (!state.thesis) {
    return <Panel title="Investment thesis"><Skeleton rows={5} label={state.stages.thesis === "running" ? "building both sides" : undefined} /></Panel>;
  }

  const t = state.thesis.data;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Bull case" className="border-t-2 border-t-up/60">
          <ul className="space-y-1 p-4">
            {t.bullCase.map((c, i) => <ClaimLine key={i} text={c.text} citations={c.citations} />)}
          </ul>
        </Panel>
        <Panel title="Bear case" className="border-t-2 border-t-down/60">
          <ul className="space-y-1 p-4">
            {t.bearCase.map((c, i) => <ClaimLine key={i} text={c.text} citations={c.citations} />)}
          </ul>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Catalysts" subtitle="Discrete events with expected timing">
          <ul className="divide-y divide-term-line">
            {t.catalysts.map((c, i) => (
              <li key={i} className="px-4 py-2.5">
                <div className="label mb-1 text-fact">{c.expectedTiming}</div>
                <p className="prose-ai">
                  {c.text}
                  <Cite ids={c.citations} />
                </p>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Risks" subtitle="Severity is the model's assessment">
          <ul className="divide-y divide-term-line">
            {t.risks.map((r, i) => (
              <li key={i} className="flex gap-3 px-4 py-2.5">
                <Pill tone={r.severity === "high" ? "down" : r.severity === "medium" ? "fact" : "neutral"}>{r.severity}</Pill>
                <p className="prose-ai flex-1">
                  {r.text}
                  <Cite ids={r.citations} />
                </p>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Competitive advantages">
          <ul className="space-y-1 p-4">
            {t.competitiveAdvantages.map((c, i) => <ClaimLine key={i} text={c.text} citations={c.citations} />)}
          </ul>
        </Panel>
        <Panel title="Valuation concerns">
          <ul className="space-y-1 p-4">
            {t.valuationConcerns.map((c, i) => <ClaimLine key={i} text={c.text} citations={c.citations} />)}
          </ul>
        </Panel>
      </div>

      <Panel title="Outlook">
        <div className="space-y-3 p-4">
          <div>
            <p className="label mb-1">Economic sensitivity</p>
            <p className="prose-ai">{t.economicSensitivity}</p>
          </div>
          <div>
            <p className="label mb-1">Long-term view</p>
            <p className="prose-ai">{t.longTermOutlook}</p>
          </div>
        </div>
        <Gaps items={t.evidenceGaps} title="Evidence the model would need and does not have" />
      </Panel>
    </div>
  );
}

export function RecommendationPanel({ state }: { state: ResearchState }) {
  const err = state.sectionErrors.recommendation;
  if (err) return <Panel title="Rating"><SectionError section="Rating" message={err} /></Panel>;
  if (!state.recommendation) {
    return <Panel title="Rating"><Skeleton rows={3} label={state.stages.recommendation === "running" ? "forming a view" : undefined} /></Panel>;
  }

  const r = state.recommendation.data;
  const tone = r.rating === "buy" ? "up" : r.rating === "sell" ? "down" : "fact";

  return (
    <Panel title="Rating" subtitle="Research output, not investment advice">
      <div className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Pill tone={tone}>{r.rating}</Pill>
          <span className="font-mono text-xs text-infer">{r.confidence}% confidence</span>
          <span className="font-mono text-2xs text-term-dim">horizon {r.horizon}</span>
        </div>

        <div className="mt-2 h-1 w-full max-w-xs rounded-full bg-term-raised">
          <div className="h-full rounded-full bg-infer/70" style={{ width: `${r.confidence}%` }} />
        </div>

        <ul className="mt-4 space-y-1">
          {r.reasoning.map((c, i) => <ClaimLine key={i} text={c.text} citations={c.citations} />)}
        </ul>

        {r.whatWouldChangeThis.length > 0 && (
          <div className="mt-4">
            <p className="label">What would change this view</p>
            <ul className="mt-1 space-y-1">
              {r.whatWouldChangeThis.map((w) => (
                <li key={w} className="prose-ai flex gap-2">
                  <span aria-hidden className="mt-[0.55em] h-1 w-1 shrink-0 rounded-full bg-fact/70" />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="border-t border-term-line bg-term-bg/40 px-4 py-3">
        <p className="label text-fact">Data quality caveat</p>
        <p className="mt-1 font-mono text-2xs leading-relaxed text-term-dim">{r.dataQualityCaveat}</p>
        {state.missing && state.missing.length > 0 && (
          <p className="mt-1.5 font-mono text-2xs text-down">
            Sections that failed to generate: {state.missing.join(", ")}
          </p>
        )}
      </div>
    </Panel>
  );
}

export function EarningsPanel({ state }: { state: ResearchState }) {
  const err = state.sectionErrors.earnings;
  if (err) return <Panel title="Earnings analysis"><SectionError section="Earnings" message={err} /></Panel>;
  if (!state.earnings) {
    return <Panel title="Earnings analysis"><Skeleton rows={4} label={state.stages.earnings === "running" ? "reading the quarter" : undefined} /></Panel>;
  }

  const e = state.earnings.data;
  const groups = [
    ["Versus consensus", e.versusConsensus],
    ["Guidance", e.guidance],
    ["Management commentary", e.managementCommentary],
    ["Risks raised", e.risksRaised],
    ["Opportunities raised", e.opportunitiesRaised],
  ] as const;

  return (
    <Panel title="Earnings analysis" subtitle={e.period}>
      <div className="p-4">
        <p className="prose-ai">{e.headlineResult}</p>
        {groups.map(([label, claims]) =>
          claims.length === 0 ? null : (
            <div key={label} className="mt-4">
              <p className="label mb-1">{label}</p>
              <ul className="space-y-1">
                {claims.map((c, i) => <ClaimLine key={i} text={c.text} citations={c.citations} />)}
              </ul>
            </div>
          )
        )}
      </div>
      <Gaps items={e.notDisclosed} title="Not retrieved (transcripts are not fetched in this build)" />
    </Panel>
  );
}
