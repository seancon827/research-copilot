import { z } from "zod";

/**
 * Every structured model output has a schema. Two payoffs:
 *  - the UI can render confidently instead of defensively
 *  - `confidence` and `unsupported` fields are *required*, so the model has to
 *    commit to a stated uncertainty rather than sounding uniformly assured
 */

/** A claim plus the evidence ids backing it. Validated against the pack later. */
export const Claim = z.object({
  text: z.string().min(1),
  citations: z.array(z.string()).default([]),
});
export type Claim = z.infer<typeof Claim>;

export const CompanyOverview = z.object({
  businessSummary: z.string(),
  products: z.array(z.object({ name: z.string(), description: z.string(), citations: z.array(z.string()).default([]) })),
  revenueBreakdown: z.array(
    z.object({
      segment: z.string(),
      sharePercent: z.number().nullable().describe("null when the split is not disclosed in the evidence"),
      citations: z.array(z.string()).default([]),
    })
  ),
  geographicExposure: z.array(
    z.object({ region: z.string(), sharePercent: z.number().nullable(), citations: z.array(z.string()).default([]) })
  ),
  competitors: z.array(z.object({ name: z.string(), basisOfCompetition: z.string() })),
  industry: z.string(),
  management: z.array(z.object({ name: z.string(), role: z.string(), citations: z.array(z.string()).default([]) })),
  notDisclosed: z.array(z.string()).describe("Requested items absent from the evidence"),
});
export type CompanyOverview = z.infer<typeof CompanyOverview>;

export const EarningsAnalysis = z.object({
  period: z.string(),
  headlineResult: z.string(),
  versusConsensus: z.array(Claim),
  guidance: z.array(Claim),
  managementCommentary: z.array(Claim),
  risksRaised: z.array(Claim),
  opportunitiesRaised: z.array(Claim),
  notDisclosed: z.array(z.string()),
});
export type EarningsAnalysis = z.infer<typeof EarningsAnalysis>;

export const FilingSummary = z.object({
  form: z.string(),
  filedAt: z.string(),
  riskFactors: z.array(Claim),
  legalIssues: z.array(Claim),
  liquidity: z.array(Claim),
  futureStrategy: z.array(Claim),
  capitalAllocation: z.array(Claim),
  acquisitions: z.array(Claim),
  managementDiscussion: z.array(Claim),
  /** Genuinely new language versus the prior comparable filing, if detectable. */
  notableChanges: z.array(Claim),
});
export type FilingSummary = z.infer<typeof FilingSummary>;

export const NewsLabels = z.object({
  clusters: z.array(
    z.object({
      id: z.string(),
      label: z.string().describe("3-6 word topic label"),
      summary: z.string().describe("One plain-English sentence"),
      sentiment: z.enum(["bullish", "neutral", "bearish"]),
      /** How directly this bears on the investment case, 0-1. */
      materiality: z.number().min(0).max(1),
    })
  ),
});
export type NewsLabels = z.infer<typeof NewsLabels>;

export const SentimentRead = z.object({
  newsSentiment: z.number().min(-1).max(1),
  filingSentiment: z.number().min(-1).max(1),
  earningsSentiment: z.number().min(-1).max(1),
  rationale: z.array(Claim),
  /** Signals pointing the opposite way to the overall read. */
  contradictorySignals: z.array(Claim),
});
export type SentimentRead = z.infer<typeof SentimentRead>;

export const InvestmentThesis = z.object({
  bullCase: z.array(Claim),
  bearCase: z.array(Claim),
  catalysts: z.array(z.object({ text: z.string(), expectedTiming: z.string(), citations: z.array(z.string()).default([]) })),
  risks: z.array(z.object({ text: z.string(), severity: z.enum(["low", "medium", "high"]), citations: z.array(z.string()).default([]) })),
  valuationConcerns: z.array(Claim),
  competitiveAdvantages: z.array(Claim),
  economicSensitivity: z.string(),
  longTermOutlook: z.string(),
  /** Facts the analyst would need that the evidence pack does not contain. */
  evidenceGaps: z.array(z.string()),
});
export type InvestmentThesis = z.infer<typeof InvestmentThesis>;

export const ValuationCommentary = z.object({
  assumptionCritique: z.array(
    z.object({
      assumption: z.string(),
      assessment: z.enum(["conservative", "reasonable", "aggressive"]),
      reasoning: z.string(),
      citations: z.array(z.string()).default([]),
    })
  ),
  keySwingFactor: z.string(),
  suggestedRevisions: z.array(z.object({ assumption: z.string(), suggested: z.string(), why: z.string() })),
});
export type ValuationCommentary = z.infer<typeof ValuationCommentary>;

export const Recommendation = z.object({
  rating: z.enum(["buy", "hold", "sell"]),
  confidence: z.number().min(0).max(100),
  horizon: z.enum(["3-6 months", "6-12 months", "1-3 years", "3+ years"]),
  reasoning: z.array(Claim),
  /** What would have to happen for this rating to be wrong. */
  whatWouldChangeThis: z.array(z.string()),
  dataQualityCaveat: z.string(),
});
export type Recommendation = z.infer<typeof Recommendation>;
