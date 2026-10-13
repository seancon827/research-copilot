"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CompanyProfile,
  DerivedMetrics,
  EarningsEvent,
  Evidence,
  Filing,
  FinancialPeriod,
  NewsCluster,
  ProviderAttempt,
  Quote,
} from "./types";
import type { DcfResult } from "./finance/dcf";
import type { Multiples, RelativeValuation } from "./finance/comps";
import type * as S from "./ai/schemas";

/**
 * Consumes the /api/research SSE stream.
 *
 * Deliberately uses fetch + a manual reader rather than EventSource: EventSource
 * cannot send headers, cannot be aborted cleanly on unmount, and only speaks GET
 * without credentials control. The manual reader also lets us handle a partial
 * final chunk correctly, which is the bug most hand-rolled SSE clients ship with.
 */

export interface Verified<T> {
  data: T;
  invalidCitations: string[];
  unsupportedClaims: string[];
}

export interface ResearchState {
  status: "idle" | "streaming" | "complete" | "error";
  stages: Record<string, "running" | "done" | "failed">;
  error?: string;
  sectionErrors: Record<string, string>;
  attempts: ProviderAttempt[];

  profile?: CompanyProfile;
  quote?: Quote;
  annual?: FinancialPeriod[];
  quarterly?: FinancialPeriod[];
  derived?: DerivedMetrics[];
  ttm?: FinancialPeriod;
  earningsHistory?: EarningsEvent[];
  filingsIndex?: Filing[];
  newsClusters?: NewsCluster[];
  evidence: Evidence[];

  overview?: Verified<S.CompanyOverview>;
  earnings?: Verified<S.EarningsAnalysis>;
  filingSummary?: { summary: S.FilingSummary; filing: Filing };
  sentiment?: Verified<S.SentimentRead> & {
    composite: {
      bullishScore: number;
      bearishScore: number;
      overall: string;
      confidence: number;
      channels: { news: number; filings: number; earnings: number };
      method: string;
    };
  };
  thesis?: Verified<S.InvestmentThesis>;
  valuation?: {
    dcf: DcfResult;
    subject: Multiples;
    peers: Multiples[];
    relative: RelativeValuation;
    currentPrice?: number;
    marginOfSafetyPercent?: number;
  };
  valuationCommentary?: Verified<S.ValuationCommentary>;
  recommendation?: Verified<S.Recommendation>;
  missing?: string[];
}

const initial: ResearchState = {
  status: "idle",
  stages: {},
  sectionErrors: {},
  attempts: [],
  evidence: [],
};

export function useResearchStream(ticker: string) {
  const [state, setState] = useState<ResearchState>(initial);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ ...initial, status: "streaming" });

    try {
      const res = await fetch(`/api/research?ticker=${encodeURIComponent(ticker)}`, {
        signal: controller.signal,
        headers: { accept: "text/event-stream" },
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `Request failed with ${res.status}` }));
        setState((s) => ({ ...s, status: "error", error: body.error ?? `Request failed with ${res.status}` }));
        return;
      }
      if (!res.body) {
        setState((s) => ({ ...s, status: "error", error: "The server returned no stream body." }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line. Anything after the last
        // separator is an incomplete frame and must stay in the buffer.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const eventLine = frame.split("\n").find((l) => l.startsWith("event: "));
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!eventLine || !dataLine) continue;

          const event = eventLine.slice(7).trim();
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(dataLine.slice(6));
          } catch {
            continue;
          }
          setState((s) => reduce(s, event, payload));
        }
      }

      setState((s) => (s.status === "streaming" ? { ...s, status: "complete" } : s));
    } catch (err) {
      if (controller.signal.aborted) return; // unmount or re-run, not a failure
      setState((s) => ({
        ...s,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [ticker]);

  useEffect(() => {
    void run();
    return () => abortRef.current?.abort();
  }, [run]);

  return { ...state, retry: run };
}

/** Single reducer so every event has exactly one place it can mutate state. */
function reduce(s: ResearchState, event: string, p: Record<string, unknown>): ResearchState {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const any = p as any;

  switch (event) {
    case "progress":
      return { ...s, stages: { ...s.stages, [any.stage]: any.status } };
    case "diagnostics":
      return { ...s, attempts: any.attempts ?? [] };
    case "profile":
      return { ...s, profile: any.profile, quote: any.quote ?? undefined };
    case "financials":
      return {
        ...s,
        annual: any.annual ?? undefined,
        quarterly: any.quarterly ?? undefined,
        derived: any.derived ?? undefined,
        ttm: any.ttm ?? undefined,
        earningsHistory: any.earnings ?? undefined,
      };
    case "filings_index":
      return { ...s, filingsIndex: any.filings };
    case "news_raw":
      // Show unlabelled clusters immediately; the labelled version replaces them.
      return { ...s, newsClusters: s.newsClusters ?? any.clusters };
    case "news":
      return { ...s, newsClusters: any.clusters };
    case "evidence":
      return { ...s, evidence: any.items ?? [] };
    case "overview":
      return { ...s, overview: any };
    case "earnings":
      return { ...s, earnings: any };
    case "filings":
      return { ...s, filingSummary: { summary: any.summary, filing: any.filing } };
    case "sentiment":
      return { ...s, sentiment: any };
    case "thesis":
      return { ...s, thesis: any };
    case "valuation":
      return { ...s, valuation: any };
    case "valuation_commentary":
      return { ...s, valuationCommentary: any };
    case "recommendation":
      return { ...s, recommendation: any };
    case "section_error":
      return { ...s, sectionErrors: { ...s.sectionErrors, [any.section]: any.message } };
    case "complete":
      return { ...s, status: "complete", missing: any.missing, attempts: any.attempts ?? s.attempts };
    case "error":
      return { ...s, status: "error", error: any.message };
    default:
      return s;
  }
}
