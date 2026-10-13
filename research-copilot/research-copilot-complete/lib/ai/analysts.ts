import { complete, completeJson } from "./client";
import { EvidencePack, verify, type VerifiedText } from "./evidence";
import * as P from "./prompts";
import * as S from "./schemas";
import { chunk, extractSections } from "../sec/sections";
import { filingText } from "../providers/edgar";
import { cached, key, TTL } from "../cache";
import type { DcfResult } from "../finance/dcf";
import type { Filing, NewsCluster } from "../types";

/**
 * The analysis pipeline. Each function takes an evidence pack and returns a
 * schema-validated result plus citation diagnostics.
 */

export interface Verified<T> {
  data: T;
  invalidCitations: string[];
  unsupportedClaims: string[];
}

/** Walk a validated object and verify every `citations` array against the pack. */
function verifyClaims<T>(data: T, pack: EvidencePack): Verified<T> {
  const invalid = new Set<string>();
  const unsupported: string[] = [];

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;

    const record = node as Record<string, unknown>;
    if (Array.isArray(record.citations) && typeof record.text === "string") {
      const ids = (record.citations as unknown[]).filter((c): c is string => typeof c === "string");
      const valid = ids.filter((id) => {
        if (pack.has(id)) return true;
        invalid.add(id);
        return false;
      });
      record.citations = valid;
      // Only factual-looking claims are required to be cited; see evidence.ts.
      if (valid.length === 0 && /\d|[$€£¥]|%/.test(record.text)) {
        unsupported.push(record.text.slice(0, 200));
      }
    }
    Object.values(record).forEach(walk);
  };

  walk(data);
  return { data, invalidCitations: [...invalid], unsupportedClaims: unsupported };
}

const withEvidence = (pack: EvidencePack, task: string) =>
  `EVIDENCE\n${pack.render()}\n\nEND EVIDENCE\n\n${task}`;

// --------------------------------------------------------------------------
// Filing summarisation: map-reduce over Item sections
// --------------------------------------------------------------------------

/**
 * A 10-K is 300k–800k characters — far past any usable context window once you
 * add the rest of the research. So: extract the Items we care about, chunk each,
 * summarise chunks in parallel (map), then reduce the per-section summaries into
 * one structured object.
 *
 * Parallelism is capped at 4 to stay inside rate limits, since a single 10-K can
 * produce 40+ chunks.
 */
export async function summariseFiling(filing: Filing): Promise<{
  summary: S.FilingSummary;
  sections: { label: string; summary: string; url: string; filedAt: string }[];
}> {
  return cached(key("analysis:filing", { acc: filing.accessionNumber }), TTL.filingDocument, async () => {
    const text = await filingText(filing.primaryDocUrl);
    const sections = extractSections(text, filing.form);

    if (sections.length === 0) {
      throw new Error(
        `Could not locate standard Item sections in ${filing.form} filed ${filing.filedAt}. The document may be a paper-style or exhibit-only filing.`
      );
    }

    const sectionSummaries = await mapLimit(sections, 4, async (section) => {
      const parts = chunk(section.text);
      // Summarise each chunk, then stitch. Chunks are summarised with the
      // section label in context so the model knows what it is reading.
      const partSummaries = await mapLimit(parts.slice(0, 8), 3, (part, i) =>
        complete({
          system: P.FILING_PROMPT,
          user: `Filing: ${filing.form} filed ${filing.filedAt}\nSection: ${section.label} (part ${i + 1} of ${Math.min(
            parts.length,
            8
          )})\n\n---\n${part}\n---\n\nSummarise the material, filer-specific content of this part in at most 6 short bullets. Omit boilerplate. If this part contains nothing material, reply exactly: NOTHING MATERIAL.`,
          temperature: 0.1,
          maxTokens: 600,
        })
      );

      const kept = partSummaries.filter((s) => !/^NOTHING MATERIAL/i.test(s.trim()));
      return { label: section.label, key: section.key, summary: kept.join("\n") || "No material content identified." };
    });

    const reduceInput = sectionSummaries
      .map((s) => `## ${s.label}\n${s.summary}`)
      .join("\n\n");

    const summary = await completeJson(S.FilingSummary, {
      system: P.FILING_PROMPT,
      user: `Filing: ${filing.form} filed ${filing.filedAt}\nSource: ${filing.primaryDocUrl}\n\nThe following are per-section summaries produced from the filing text. Consolidate them into the required structure. Cite section names in your claim text where useful; you have no numeric evidence ids for this task, so leave citations arrays empty.\n\n${reduceInput}`,
      maxTokens: 3000,
    });

    return {
      summary,
      sections: sectionSummaries.map((s) => ({
        label: s.label,
        summary: s.summary.slice(0, 1800),
        url: filing.primaryDocUrl,
        filedAt: filing.filedAt,
      })),
    };
  });
}

/** Bounded-concurrency map. Avoids a dependency and makes the limit explicit. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await fn(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}

// --------------------------------------------------------------------------
// Section generators
// --------------------------------------------------------------------------

export async function generateOverview(pack: EvidencePack, ticker: string) {
  const data = await completeJson(S.CompanyOverview, {
    system: P.OVERVIEW_PROMPT,
    user: withEvidence(pack, `Produce the company overview for ${ticker}.`),
  });
  return verifyClaims(data, pack);
}

export async function generateEarnings(pack: EvidencePack, ticker: string) {
  const data = await completeJson(S.EarningsAnalysis, {
    system: P.EARNINGS_PROMPT,
    user: withEvidence(pack, `Analyse the most recent reported quarter for ${ticker}.`),
  });
  return verifyClaims(data, pack);
}

export async function labelNews(clusters: NewsCluster[]): Promise<NewsCluster[]> {
  if (clusters.length === 0) return [];
  const input = clusters
    .map(
      (c) =>
        `id=${c.id} | importance=${c.importance} | sources=${c.members.length} | ${c.lead.headline}${
          c.lead.summary ? ` — ${c.lead.summary.slice(0, 240)}` : ""
        }`
    )
    .join("\n");

  const labels = await completeJson(S.NewsLabels, {
    system: P.NEWS_LABEL_PROMPT,
    user: `Clusters:\n${input}\n\nReturn one entry per cluster id.`,
    maxTokens: 2200,
  });

  const byId = new Map(labels.clusters.map((l) => [l.id, l]));
  return clusters.map((c) => {
    const l = byId.get(c.id);
    if (!l) return c;
    return {
      ...c,
      label: l.label,
      summary: l.summary,
      sentiment: l.sentiment === "bullish" ? 1 : l.sentiment === "bearish" ? -1 : 0,
      // Blend algorithmic importance with model-judged materiality. Neither
      // alone is right: the algorithm can't tell a rating change from a recall,
      // and the model over-weights dramatic language.
      importance: Math.round(c.importance * 0.6 + l.materiality * 100 * 0.4),
    };
  });
}

export async function generateSentiment(pack: EvidencePack, clusters: NewsCluster[], ticker: string) {
  const read = await completeJson(S.SentimentRead, {
    system: P.SENTIMENT_PROMPT,
    user: withEvidence(pack, `Read sentiment for ${ticker} across the three channels.`),
  });
  const verified = verifyClaims(read, pack);

  /**
   * The composite score is computed here, not asked of the model.
   *
   * Channel weights reflect information value: filings are audited and legally
   * binding, earnings are point-in-time and verified, news is fast but noisy.
   * News is additionally weighted by cluster importance so a single loud
   * low-materiality story cannot swing the read.
   */
  const importanceWeighted = weightedNewsSentiment(clusters);
  const newsScore = importanceWeighted ?? read.newsSentiment;

  const channels = [
    { score: read.filingSentiment, weight: 0.4 },
    { score: read.earningsSentiment, weight: 0.35 },
    { score: newsScore, weight: 0.25 },
  ];
  const composite = channels.reduce((s, c) => s + c.score * c.weight, 0);

  // Bullish/bearish are the two sides of the same composite, expressed 0-100
  // so the UI can render opposing bars that always sum to 100.
  const bullish = Math.round(((composite + 1) / 2) * 100);

  /**
   * Confidence is a function of evidence breadth and channel agreement — never
   * of how strongly the model phrased itself. Disagreement between channels
   * lowers confidence, which is the behaviour an analyst expects.
   */
  const spread = Math.max(...channels.map((c) => c.score)) - Math.min(...channels.map((c) => c.score));
  const breadth = Math.min(1, pack.size / 25);
  const confidence = Math.round(Math.max(10, Math.min(90, (1 - spread / 2) * 60 + breadth * 30)));

  return {
    ...verified,
    composite: {
      bullishScore: bullish,
      bearishScore: 100 - bullish,
      overall: composite > 0.15 ? "bullish" : composite < -0.15 ? "bearish" : ("neutral" as const),
      confidence,
      channels: {
        news: newsScore,
        filings: read.filingSentiment,
        earnings: read.earningsSentiment,
      },
      method:
        "Weighted composite: filings 40%, earnings 35%, news 25%. News is itself importance-weighted across clusters. Confidence falls as channels disagree and rises with evidence breadth.",
    },
  };
}

function weightedNewsSentiment(clusters: NewsCluster[]): number | undefined {
  const scored = clusters.filter((c) => c.sentiment !== undefined);
  if (scored.length === 0) return undefined;
  const totalWeight = scored.reduce((s, c) => s + c.importance, 0);
  if (totalWeight === 0) return undefined;
  return scored.reduce((s, c) => s + (c.sentiment ?? 0) * c.importance, 0) / totalWeight;
}

export async function generateThesis(pack: EvidencePack, ticker: string) {
  const data = await completeJson(S.InvestmentThesis, {
    system: P.THESIS_PROMPT,
    user: withEvidence(pack, `Build the investment thesis for ${ticker}.`),
    maxTokens: 3200,
  });
  return verifyClaims(data, pack);
}

export async function critiqueValuation(pack: EvidencePack, dcf: DcfResult, ticker: string) {
  const assumptionTable = Object.entries(dcf.assumptions.provenance)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const data = await completeJson(S.ValuationCommentary, {
    system: P.VALUATION_PROMPT,
    user: withEvidence(
      pack,
      `A DCF for ${ticker} has been computed with these results:
- WACC ${(dcf.wacc * 100).toFixed(2)}% (cost of equity ${(dcf.costOfEquity * 100).toFixed(2)}%, debt weight ${(
        dcf.debtWeight * 100
      ).toFixed(1)}%)
- Terminal growth ${(dcf.assumptions.terminalGrowth * 100).toFixed(2)}%
- Enterprise value ${dcf.enterpriseValue.toFixed(0)}, equity value ${dcf.equityValue.toFixed(0)}
- Intrinsic value per share ${dcf.intrinsicValuePerShare.toFixed(2)}
- ${(dcf.terminalValueShare * 100).toFixed(0)}% of enterprise value is in the terminal period
- Per-share value across the sensitivity grid ranges ${Math.min(
        ...dcf.sensitivity.grid.flat()
      ).toFixed(2)} to ${Math.max(...dcf.sensitivity.grid.flat()).toFixed(2)}
${dcf.warnings.length ? `- Model warnings: ${dcf.warnings.join(" ")}` : ""}

Assumptions and where each came from:
${assumptionTable}

Critique the assumptions against the reported history in the evidence.`
    ),
  });
  return verifyClaims(data, pack);
}

export async function generateRecommendation(
  pack: EvidencePack,
  context: { ticker: string; sentimentConfidence: number; marginOfSafety?: number; missing: string[] }
) {
  const data = await completeJson(S.Recommendation, {
    system: P.RECOMMENDATION_PROMPT,
    user: withEvidence(
      pack,
      `Issue a rating for ${context.ticker}.

Computed inputs you should weigh:
- Sentiment model confidence: ${context.sentimentConfidence}%
- Margin of safety vs the DCF intrinsic value: ${
        context.marginOfSafety !== undefined ? `${context.marginOfSafety.toFixed(1)}%` : "not computable"
      }
- Data categories that could NOT be retrieved: ${context.missing.length ? context.missing.join(", ") : "none"}

The evidence pack contains ${pack.size} items. Reflect that in your confidence.`
    ),
  });
  return verifyClaims(data, pack);
}

/** Free-text streaming answer for the chat surface. */
export function verifyStreamed(text: string, pack: EvidencePack): VerifiedText {
  return verify(text, pack);
}
