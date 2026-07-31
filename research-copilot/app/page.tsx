"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";

/**
 * The hero is the pipeline, not a marketing headline.
 *
 * The most characteristic thing about this product is that it tells you where
 * every number came from, so the landing page's job is to show the ten stages a
 * ticker passes through and label which ones are retrieval, which are
 * deterministic computation, and which are model inference. Anyone evaluating
 * this can see the architecture before they type anything.
 */

const STAGES = [
  { stage: "Retrieval", detail: "Profile, quote, statements, earnings, filings, news — concurrent, with provider failover", kind: "data" },
  { stage: "Normalisation", detail: "As-filed XBRL concepts mapped to a common schema across vendors", kind: "data" },
  { stage: "Ratio derivation", detail: "Margins, ROIC, ROE, FCF conversion computed locally, not taken from a vendor", kind: "compute" },
  { stage: "News clustering", detail: "Embedding similarity, single-link agglomeration, importance scoring", kind: "compute" },
  { stage: "Filing extraction", detail: "Item sections located in raw HTML, chunked, summarised map-reduce", kind: "data" },
  { stage: "Discounted cash flow", detail: "Two-stage FCFF, CAPM WACC, sensitivity grid — plain TypeScript", kind: "compute" },
  { stage: "Evidence pack", detail: "Every retrieved fact assigned a citable id. The model sees nothing else.", kind: "compute" },
  { stage: "Analysis", detail: "Overview, earnings, sentiment, thesis, assumption critique", kind: "model" },
  { stage: "Citation verification", detail: "Invalid ids stripped; uncited figures flagged as unsupported", kind: "compute" },
  { stage: "Rating", detail: "Confidence scaled to evidence quality, not narrative conviction", kind: "model" },
] as const;

const KIND_STYLE = {
  data: { label: "retrieved", className: "text-fact border-fact/40 bg-fact/10" },
  compute: { label: "computed", className: "text-up border-up/40 bg-up/10" },
  model: { label: "inferred", className: "text-infer border-infer/40 bg-infer/10" },
} as const;

const EXAMPLES = ["AAPL", "MSFT", "NVDA", "JPM", "XOM"];

export default function HomePage() {
  const router = useRouter();
  const [query, setQuery] = useState("");

  const go = (raw: string) => {
    const clean = raw.trim().toUpperCase();
    if (/^[A-Z][A-Z.-]{0,9}$/.test(clean)) router.push(`/${clean}`);
  };

  return (
    <div className="flex h-dvh flex-col lg:flex-row">
      <div className="hidden lg:block">
        <Sidebar />
      </div>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-5 py-10 sm:py-16">
          <p className="label">Equity research pipeline</p>
          <h1 className="mt-3 text-2xl leading-tight text-term-bright sm:text-3xl">
            Every claim on the page carries the id of the source it came from.
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-term-dim">
            Enter a ticker. Ten stages run: retrieval across four data providers with failover, ratio derivation and a
            discounted cash flow computed in application code, then model analysis bounded to a closed evidence pack.
            Citations are verified programmatically — uncited figures are marked unsupported rather than quietly kept.
          </p>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              go(query);
            }}
            className="mt-7 flex flex-col gap-2 sm:flex-row"
          >
            <div className="flex flex-1 items-center gap-2 border border-term-line bg-term-panel px-3 py-2.5 focus-within:border-fact/60">
              <span className="font-mono text-sm text-fact" aria-hidden>
                ›
              </span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value.toUpperCase())}
                placeholder="AAPL"
                maxLength={10}
                aria-label="Stock ticker"
                className="w-full bg-transparent font-mono text-base uppercase text-term-bright placeholder:text-term-dim focus:outline-none"
              />
            </div>
            <button
              type="submit"
              className="border border-fact/50 bg-fact/10 px-5 py-2.5 font-mono text-xs uppercase tracking-wider text-fact transition-colors hover:bg-fact/20"
            >
              run research
            </button>
          </form>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="label">try</span>
            {EXAMPLES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => go(t)}
                className="border border-term-line px-2 py-1 font-mono text-2xs text-term-dim transition-colors hover:border-fact/50 hover:text-fact"
              >
                {t}
              </button>
            ))}
          </div>

          <ol className="mt-12 border-t border-term-line">
            {STAGES.map((s, i) => {
              const style = KIND_STYLE[s.kind];
              return (
                <li key={s.stage} className="flex gap-4 border-b border-term-line py-3">
                  <span className="mt-0.5 w-6 shrink-0 font-mono text-2xs text-term-dim">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm text-term-bright">{s.stage}</span>
                      <span
                        className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-2xs uppercase tracking-wider ${style.className}`}
                      >
                        {style.label}
                      </span>
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-term-dim">{s.detail}</p>
                  </div>
                </li>
              );
            })}
          </ol>

          <p className="mt-8 font-mono text-2xs leading-relaxed text-term-dim">
            Research tooling, not investment advice. Ratings are generated by a language model from retrieved public
            data and are not a recommendation to buy or sell any security.
          </p>
        </div>
      </main>
    </div>
  );
}
