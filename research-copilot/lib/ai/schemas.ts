import { z } from "zod";

/**
 * Every structured model output has a schema. Two payoffs:
 *  - the UI can render confidently instead of defensively
 *  - `confidence` and `unsupported` fields are *required*, so the model has to
 *    commit to a stated uncertainty rather than sounding uniformly assured
 *
 * ---------------------------------------------------------------------------
 * A note on tolerance, because it is the whole design of this file.
 *
 * A schema has two jobs, and they pull in opposite directions: guarantee the
 * shape the UI renders, and survive contact with a model that is answering in
 * good faith but writing JSON from a description rather than a type. Early
 * versions of this file only did the first, and the result was a report where
 * whole sections failed because the model had written `"Datacenter"` where the
 * schema wanted `{segment: "Datacenter", citations: []}`, or `null` for a list
 * it had nothing to put in.
 *
 * None of those are wrong answers. They are the same answer in a slightly
 * different wrapper, and rejecting them wastes a repair round-trip at best and
 * loses the section at worst. So the coercions below absorb the three shape
 * variations models actually produce — a lone item where a list was expected,
 * `null` for an empty list, and a bare string where an object was expected —
 * and normalise them to the one shape the UI consumes.
 *
 * What is deliberately *not* tolerated: anything that would change meaning.
 * Sentiment scores, confidence, ratings and cluster ids still have to arrive as
 * what they claim to be. Those carry information; a wrapper does not.
 * ---------------------------------------------------------------------------
 */

// --------------------------------------------------------------------------
// Coercions
// --------------------------------------------------------------------------

/** `null` and a lone item both become arrays. Models return both for lists. */
const toArray = (v: unknown): unknown =>
  v === null || v === undefined ? [] : Array.isArray(v) ? v : [v];

const list = <S extends z.ZodTypeAny>(item: S) => z.preprocess(toArray, z.array(item));

/**
 * Accept a bare string where an object was expected, treating it as the
 * object's primary text field. Every other field on these shapes carries a
 * default so the result is still complete.
 */
const fromString = (key: string) => (v: unknown) => (typeof v === "string" ? { [key]: v } : v);

/** Evidence ids. Always optional on input, always an array on output. */
const cites = z.array(z.string()).default([]);

/**
 * A percentage that may arrive as 45, "45", "45%" or null. Only used on fields
 * already declared nullable, so an unparseable value degrades to "not
 * disclosed" rather than failing the whole section.
 */
const pct = z.preprocess((v: unknown) => {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[%,\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}, z.number().nullable());

/**
 * Enum matching that ignores case and en/em dashes. "Buy" and "6–12 months"
 * are the intended values typed slightly differently, not different answers.
 */
const lenientEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((v: unknown) => {
    if (typeof v !== "string") return v;
    const norm = v.trim().toLowerCase().replace(/[–—]/g, "-");
    return values.find((o) => o.toLowerCase() === norm) ?? v;
  }, z.enum(values));

// --------------------------------------------------------------------------
// Schemas
// --------------------------------------------------------------------------

/** A claim plus the evidence ids backing it. Validated against the pack later. */
export const Claim = z.preprocess(
  fromString("text"),
  z.object({
    text: z.string().min(1),
    citations: cites,
  })
);
export type Claim = z.output<typeof Claim>;

export const CompanyOverview = z.object({
  businessSummary: z.string(),
  products: list(
    z.preprocess(
      fromString("name"),
      z.object({ name: z.string(), description: z.string().default(""), citations: cites })
    )
  ),
  revenueBreakdown: list(
    z.preprocess(
      fromString("segment"),
      z.object({
        segment: z.string(),
        sharePercent: pct.describe("null when the split is not disclosed in the evidence"),
        citations: cites,
      })
    )
  ),
  geographicExposure: list(
    z.preprocess(
      fromString("region"),
      z.object({ region: z.string(), sharePercent: pct, citations: cites })
    )
  ),
  competitors: list(
    z.preprocess(
      fromString("name"),
      z.object({ name: z.string(), basisOfCompetition: z.string().default("") })
    )
  ),
  industry: z.string(),
  management: list(
    z.preprocess(
      fromString("name"),
      z.object({ name: z.string(), role: z.string().default(""), citations: cites })
    )
  ),
  notDisclosed: list(z.string()).describe("Requested items absent from the evidence"),
});
export type CompanyOverview = z.infer<typeof CompanyOverview>;

export const EarningsAnalysis = z.object({
  period: z.string(),
  headlineResult: z.string(),
  versusConsensus: list(Claim),
  guidance: list(Claim),
  managementCommentary: list(Claim),
  risksRaised: list(Claim),
  opportunitiesRaised: list(Claim),
  notDisclosed: list(z.string()),
});
export type EarningsAnalysis = z.infer<typeof EarningsAnalysis>;

export const FilingSummary = z.object({
  form: z.string(),
  filedAt: z.string(),
  riskFactors: list(Claim),
  legalIssues: list(Claim),
  liquidity: list(Claim),
  futureStrategy: list(Claim),
  capitalAllocation: list(Claim),
  acquisitions: list(Claim),
  managementDiscussion: list(Claim),
  /** Genuinely new language versus the prior comparable filing, if detectable. */
  notableChanges: list(Claim),
});
export type FilingSummary = z.infer<typeof FilingSummary>;

export const NewsLabels = z.object({
  // Not coerced from strings: every cluster must carry the id it was given, or
  // labels cannot be matched back to the clusters they describe.
  clusters: list(
    z.object({
      id: z.string(),
      label: z.string().describe("3-6 word topic label"),
      summary: z.string().describe("One plain-English sentence"),
      sentiment: lenientEnum(["bullish", "neutral", "bearish"] as const),
      /** How directly this bears on the investment case, 0-1. */
      materiality: z.coerce.number().min(0).max(1),
    })
  ),
});
export type NewsLabels = z.infer<typeof NewsLabels>;

export const SentimentRead = z.object({
  newsSentiment: z.coerce.number().min(-1).max(1),
  filingSentiment: z.coerce.number().min(-1).max(1),
  earningsSentiment: z.coerce.number().min(-1).max(1),
  rationale: list(Claim),
  /** Signals pointing the opposite way to the overall read. */
  contradictorySignals: list(Claim),
});
export type SentimentRead = z.infer<typeof SentimentRead>;

export const InvestmentThesis = z.object({
  bullCase: list(Claim),
  bearCase: list(Claim),
  catalysts: list(
    z.preprocess(
      fromString("text"),
      z.object({
        text: z.string(),
        expectedTiming: z.string().default("not stated"),
        citations: cites,
      })
    )
  ),
  risks: list(
    z.preprocess(
      fromString("text"),
      z.object({
        text: z.string(),
        severity: lenientEnum(["low", "medium", "high"] as const).default("medium"),
        citations: cites,
      })
    )
  ),
  valuationConcerns: list(Claim),
  competitiveAdvantages: list(Claim),
  economicSensitivity: z.string(),
  longTermOutlook: z.string(),
  /** Facts the analyst would need that the evidence pack does not contain. */
  evidenceGaps: list(z.string()),
});
export type InvestmentThesis = z.infer<typeof InvestmentThesis>;

export const ValuationCommentary = z.object({
  assumptionCritique: list(
    z.preprocess(
      fromString("assumption"),
      z.object({
        assumption: z.string(),
        assessment: lenientEnum(["conservative", "reasonable", "aggressive"] as const).default(
          "reasonable"
        ),
        reasoning: z.string().default(""),
        citations: cites,
      })
    )
  ),
  keySwingFactor: z.string(),
  suggestedRevisions: list(
    z.preprocess(
      fromString("assumption"),
      z.object({
        assumption: z.string(),
        suggested: z.string().default(""),
        why: z.string().default(""),
      })
    )
  ),
});
export type ValuationCommentary = z.infer<typeof ValuationCommentary>;

export const Recommendation = z.object({
  rating: lenientEnum(["buy", "hold", "sell"] as const),
  confidence: z.coerce.number().min(0).max(100),
  horizon: lenientEnum(["3-6 months", "6-12 months", "1-3 years", "3+ years"] as const),
  reasoning: list(Claim),
  /** What would have to happen for this rating to be wrong. */
  whatWouldChangeThis: list(z.string()),
  dataQualityCaveat: z.string(),
});
export type Recommendation = z.infer<typeof Recommendation>;
