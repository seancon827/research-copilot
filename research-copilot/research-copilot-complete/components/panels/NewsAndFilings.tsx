"use client";

import { useState } from "react";
import clsx from "clsx";
import { ClaimLine, Panel, Pill, SectionError, Skeleton } from "../primitives";
import { relativeTime, shortDate } from "@/lib/format";
import type { ResearchState } from "@/lib/useResearchStream";
import type { NewsCluster } from "@/lib/types";

/**
 * News is presented as clusters, not a feed. The count of corroborating outlets
 * is shown because it is the signal that a story is real rather than a single
 * outlet's take — and it is what the importance score is mostly built from.
 */
export function NewsPanel({ state }: { state: ResearchState }) {
  const err = state.sectionErrors.news;
  const clusters = state.newsClusters;

  if (err && !clusters?.length) return <Panel title="News"><SectionError section="News" message={err} /></Panel>;
  if (!clusters?.length) {
    return <Panel title="News"><Skeleton rows={4} label={state.stages.news === "running" ? "clustering headlines" : undefined} /></Panel>;
  }

  const shown = clusters.filter((c) => c.members.length > 0);

  return (
    <Panel
      title="News intelligence"
      subtitle={`${shown.length} distinct stories after deduplication · ranked by corroboration, source tier and recency`}
    >
      <ul className="divide-y divide-term-line">
        {shown.map((cluster) => (
          <NewsRow key={cluster.id} cluster={cluster} />
        ))}
      </ul>
    </Panel>
  );
}

function NewsRow({ cluster }: { cluster: NewsCluster }) {
  const [expanded, setExpanded] = useState(false);
  const others = cluster.members.filter((m) => m.url !== cluster.lead.url);

  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        {/* Importance as a vertical bar rather than a number: it is an ordinal
            score, and a bar communicates rank without implying false precision. */}
        <div
          className="mt-1 h-8 w-[3px] shrink-0 rounded-full bg-term-raised"
          title={`importance ${cluster.importance}/100`}
        >
          <div
            className="w-full rounded-full bg-fact"
            style={{ height: `${Math.min(100, cluster.importance)}%` }}
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {cluster.label && <Pill tone="neutral">{cluster.label}</Pill>}
            {cluster.sentiment !== undefined && (
              <Pill tone={cluster.sentiment > 0 ? "up" : cluster.sentiment < 0 ? "down" : "neutral"}>
                {cluster.sentiment > 0 ? "bullish" : cluster.sentiment < 0 ? "bearish" : "neutral"}
              </Pill>
            )}
            <span className="label ml-auto">{relativeTime(cluster.lead.publishedAt)}</span>
          </div>

          <a
            href={cluster.lead.url}
            target="_blank"
            rel="noreferrer"
            className="mt-1.5 block text-sm text-term-bright underline decoration-term-line hover:decoration-fact"
          >
            {cluster.lead.headline}
          </a>

          {cluster.summary && <p className="prose-ai mt-1">{cluster.summary}</p>}

          <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-2xs text-term-dim">
            <span className="text-fact">{cluster.lead.source}</span>
            {others.length > 0 && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="underline decoration-term-line hover:text-term-text"
              >
                +{others.length} corroborating {others.length === 1 ? "outlet" : "outlets"}
              </button>
            )}
          </div>

          {expanded && (
            <ul className="mt-2 space-y-1 border-l border-term-line pl-3">
              {others.map((m) => (
                <li key={m.url}>
                  <a
                    href={m.url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-2xs text-term-dim hover:text-term-text"
                  >
                    {m.source} — {m.headline}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </li>
  );
}

const FILING_GROUPS = [
  ["riskFactors", "Risk factors"],
  ["legalIssues", "Legal issues"],
  ["liquidity", "Liquidity"],
  ["futureStrategy", "Future strategy"],
  ["capitalAllocation", "Capital allocation"],
  ["acquisitions", "Acquisitions"],
  ["managementDiscussion", "Management discussion"],
  ["notableChanges", "Notable changes vs prior filing"],
] as const;

export function FilingsPanel({ state }: { state: ResearchState }) {
  const err = state.sectionErrors.filings;
  const summary = state.filingSummary;

  return (
    <div className="space-y-4">
      {err && <Panel title="Filing analysis"><SectionError section="Filing analysis" message={err} /></Panel>}

      {!err && !summary && (
        <Panel title="Filing analysis" subtitle="Extracting Item sections, then summarising each in parallel">
          <Skeleton rows={6} label={state.stages.filings === "running" ? "reading the filing — this is the slow step" : undefined} />
        </Panel>
      )}

      {summary && (
        <Panel
          title="Filing analysis"
          subtitle={`${summary.filing.form} filed ${shortDate(summary.filing.filedAt)}`}
          action={
            <a
              href={summary.filing.primaryDocUrl}
              target="_blank"
              rel="noreferrer"
              className="label text-fact underline decoration-fact/40 hover:decoration-fact"
            >
              source ↗
            </a>
          }
        >
          <div className="divide-y divide-term-line">
            {FILING_GROUPS.map(([field, label]) => {
              const claims = summary.summary[field];
              if (!claims?.length) return null;
              return (
                <div key={field} className="px-4 py-3">
                  <p className={clsx("label mb-1", field === "notableChanges" && "text-fact")}>{label}</p>
                  <ul className="space-y-1">
                    {claims.map((c, i) => (
                      <ClaimLine key={i} text={c.text} citations={c.citations} />
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      {state.filingsIndex?.length ? (
        <Panel title="Filing history" subtitle="Direct from EDGAR">
          <ul className="divide-y divide-term-line">
            {state.filingsIndex.map((f) => (
              <li key={f.accessionNumber} className="flex items-baseline gap-3 px-4 py-2">
                <Pill tone={f.form === "10-K" ? "fact" : "neutral"}>{f.form}</Pill>
                <span className="font-mono text-2xs text-term-dim">{shortDate(f.filedAt)}</span>
                {f.reportPeriod && (
                  <span className="font-mono text-2xs text-term-dim">period {f.reportPeriod}</span>
                )}
                <a
                  href={f.primaryDocUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto font-mono text-2xs text-fact underline decoration-fact/40 hover:decoration-fact"
                >
                  open ↗
                </a>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}
