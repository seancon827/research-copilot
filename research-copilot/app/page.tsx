"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { useResearchStream } from "@/lib/useResearchStream";
import { EvidenceProvider, EvidenceList, Panel, StatusRail } from "@/components/primitives";
import { CompanyHeader } from "@/components/CompanyHeader";
import { Sidebar, recordVisit } from "@/components/Sidebar";
import { ChatDock } from "@/components/ChatDock";
import { FinancialsPanel } from "@/components/panels/Financials";
import { EarningsPanel, OverviewPanel, RecommendationPanel, SentimentPanel, ThesisPanel } from "@/components/panels/Analysis";
import { ValuationPanel } from "@/components/panels/Valuation";
import { FilingsPanel, NewsPanel } from "@/components/panels/NewsAndFilings";

const TABS = [
  { id: "analysis", label: "AI analysis" },
  { id: "financials", label: "Financials" },
  { id: "valuation", label: "Valuation" },
  { id: "news", label: "News" },
  { id: "filings", label: "Filings" },
  { id: "evidence", label: "Evidence" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function TickerPage({ params }: { params: { ticker: string } }) {
  const ticker = params.ticker.toUpperCase();
  const state = useResearchStream(ticker);
  const [tab, setTab] = useState<TabId>("analysis");

  useEffect(() => {
    if (state.profile) recordVisit(ticker, state.profile.name);
  }, [ticker, state.profile]);

  const streaming = state.status === "streaming";

  return (
    <EvidenceProvider items={state.evidence}>
      <div className="flex h-dvh flex-col lg:flex-row">
        <div className="hidden lg:block">
          <Sidebar activeTicker={ticker} />
        </div>

        <main className="flex min-w-0 flex-1 flex-col">
          <CompanyHeader
            profile={state.profile}
            quote={state.quote}
            recommendation={state.recommendation?.data}
            loading={streaming}
          />

          {state.status === "error" && (
            <div className="border-b border-term-line bg-down/5 px-4 py-3">
              <p className="label text-down">Report failed</p>
              <p className="mt-1 font-mono text-xs text-term-text">{state.error}</p>
              <button
                type="button"
                onClick={() => void state.retry()}
                className="mt-2 rounded-chip border border-term-line px-3 py-1.5 font-sans text-2xs text-term-text hover:border-term-dim"
              >
                retry
              </button>
            </div>
          )}

          <ProgressRail stages={state.stages} streaming={streaming} />

          {/* Section nav. The earlier build prefixed these F1-F6 as a Bloomberg
              reference; the numbering was real but it read as costume, and a
              research note names its sections in words. */}
          <nav className="flex overflow-x-auto border-b border-term-line bg-term-panel/60" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={clsx(
                  "shrink-0 border-b-2 px-5 py-3 font-sans text-[0.8125rem] transition-colors",
                  tab === t.id
                    ? "border-b-term-bright font-medium text-term-bright"
                    : "border-b-transparent text-term-dim hover:text-term-text"
                )}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <div className="flex-1 overflow-y-auto px-gutter py-8">
            {tab === "analysis" && (
              <div className="space-y-4">
                <RecommendationPanel state={state} />
                <SentimentPanel state={state} />
                <OverviewPanel state={state} />
                <EarningsPanel state={state} />
                <ThesisPanel state={state} />
              </div>
            )}

            {tab === "financials" && (
              <FinancialsPanel
                annual={state.annual}
                derived={state.derived}
                ttm={state.ttm}
                earnings={state.earningsHistory}
                error={state.sectionErrors.financials}
                loading={streaming}
              />
            )}

            {tab === "valuation" && <ValuationPanel state={state} />}
            {tab === "news" && <NewsPanel state={state} />}
            {tab === "filings" && <FilingsPanel state={state} />}

            {tab === "evidence" && (
              <Panel
                title="Evidence pack"
                subtitle={`${state.evidence.length} items · the complete set of facts the model was allowed to use`}
              >
                {state.evidence.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-term-dim">
                    The pack is assembled once retrieval and filing analysis finish.
                  </p>
                ) : (
                  <EvidenceList />
                )}
              </Panel>
            )}
          </div>

          <ChatDock ticker={ticker} evidence={state.evidence} />
          {state.attempts.length > 0 && <StatusRail attempts={state.attempts} />}
        </main>
      </div>
    </EvidenceProvider>
  );
}

/**
 * Pipeline progress as a single row of stage markers. Nine independent stages
 * with wildly different latencies need a progress display that shows *which*
 * stage is slow, not a percentage that lies.
 */
function ProgressRail({
  stages,
  streaming,
}: {
  stages: Record<string, "running" | "done" | "failed">;
  streaming: boolean;
}) {
  const order = [
    "retrieval",
    "news",
    "valuation",
    "filings",
    "overview",
    "earnings",
    "sentiment",
    "thesis",
    "valuation_commentary",
    "recommendation",
  ];
  const entries = order.filter((s) => stages[s]);
  if (entries.length === 0 && !streaming) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-term-line bg-term-bg/60 px-4 py-1.5">
      {entries.map((stage) => {
        const status = stages[stage];
        return (
          <span key={stage} className="flex items-center gap-1.5">
            <span
              className={clsx(
                "h-1.5 w-1.5 rounded-full",
                status === "done" && "bg-up",
                status === "running" && "animate-pulse-line bg-fact",
                status === "failed" && "bg-down"
              )}
            />
            <span
              className={clsx(
                "font-mono text-2xs",
                status === "running" ? "text-fact" : status === "failed" ? "text-down" : "text-term-dim"
              )}
            >
              {stage.replace(/_/g, " ")}
            </span>
          </span>
        );
      })}
    </div>
  );
}
