import type OpenAI from "openai";
import { getFundamentals, getProfileAndQuote } from "../research";
import { filings, filingText } from "../providers/edgar";
import { extractSections } from "../sec/sections";
import { defaultAssumptions, runDcf, type DcfAssumptions } from "../finance/dcf";
import { computeMultiples } from "../finance/comps";

/**
 * Tools for the chat surface.
 *
 * Design rule: a tool returns *data*, never prose. The model does the writing.
 * Tools that return pre-written summaries make the model a pass-through and make
 * failures impossible to attribute.
 *
 * Every tool is scoped to a ticker argument rather than closing over the current
 * page, so "compare to Microsoft" works without the model needing to lie about
 * which company it is describing.
 */

export const toolDefinitions: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_financials",
      description:
        "Fetch reported annual and trailing-twelve-month financials plus derived ratios for a ticker. Use for any question about specific figures.",
      parameters: {
        type: "object",
        properties: {
          ticker: { type: "string", description: "Stock ticker, e.g. AAPL" },
        },
        required: ["ticker"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_filing_section",
      description:
        "Fetch the text of a specific section of a company's most recent 10-K or 10-Q. Use when asked what a filing actually says about risks, litigation, liquidity or strategy.",
      parameters: {
        type: "object",
        properties: {
          ticker: { type: "string" },
          form: { type: "string", enum: ["10-K", "10-Q"] },
          section: {
            type: "string",
            enum: ["business", "riskFactors", "legalProceedings", "mdna", "marketRisk", "liquidity"],
          },
        },
        required: ["ticker", "form", "section"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compare_company",
      description:
        "Fetch headline metrics and valuation multiples for another ticker, for comparison. Never compare companies from memory — always call this.",
      parameters: {
        type: "object",
        properties: { ticker: { type: "string" } },
        required: ["ticker"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_dcf_scenario",
      description:
        "Re-run the discounted cash flow model with overridden assumptions and return the new intrinsic value. Use for any 'what if' question about growth, margins, discount rate or interest rates.",
      parameters: {
        type: "object",
        properties: {
          ticker: { type: "string" },
          riskFreeRate: { type: "number", description: "Decimal, e.g. 0.05 for 5%. Raise this for 'what if rates rise'." },
          terminalGrowth: { type: "number", description: "Decimal" },
          revenueGrowthYear1to5: {
            type: "array",
            items: { type: "number" },
            description: "Five decimals, one per projection year",
          },
          terminalOperatingMargin: { type: "number", description: "Decimal" },
          beta: { type: "number" },
        },
        required: ["ticker"],
      },
    },
  },
];

type Args = Record<string, unknown>;
const str = (a: Args, k: string): string => String(a[k] ?? "").toUpperCase();
const numOpt = (a: Args, k: string): number | undefined =>
  typeof a[k] === "number" && Number.isFinite(a[k]) ? (a[k] as number) : undefined;

/**
 * Execute a tool call. Errors are returned as data, not thrown: the model needs
 * to see "this failed because X" so it can tell the user, rather than the whole
 * turn 500ing.
 */
export async function executeTool(name: string, rawArgs: string): Promise<string> {
  let args: Args;
  try {
    args = JSON.parse(rawArgs || "{}") as Args;
  } catch {
    return JSON.stringify({ error: "Could not parse tool arguments" });
  }

  try {
    switch (name) {
      case "get_financials": {
        const ticker = str(args, "ticker");
        const f = await getFundamentals(ticker);
        if (!f.annual?.length) return JSON.stringify({ error: `No fundamentals available for ${ticker}` });
        return JSON.stringify({
          ticker,
          annual: f.annual.slice(-5),
          ttm: f.ttm,
          derived: f.derived?.slice(-5),
          providersTried: f.attempts.map((a) => `${a.provider}:${a.ok ? "ok" : a.error}`),
        });
      }

      case "get_filing_section": {
        const ticker = str(args, "ticker");
        const form = String(args.form ?? "10-K");
        const wanted = String(args.section ?? "riskFactors");
        const list = await filings(ticker, [form]);
        const latest = list[0];
        if (!latest) return JSON.stringify({ error: `No ${form} on file for ${ticker}` });

        const text = await filingText(latest.primaryDocUrl);
        const sections = extractSections(text, form);
        const match = sections.find((s) => s.key === wanted);
        if (!match) {
          return JSON.stringify({
            error: `Section '${wanted}' not found in ${form} filed ${latest.filedAt}`,
            available: sections.map((s) => s.key),
          });
        }
        return JSON.stringify({
          ticker,
          form,
          filedAt: latest.filedAt,
          url: latest.primaryDocUrl,
          section: match.label,
          // Cap the payload: the model gets the substantive opening rather than
          // 200k characters that would blow the context window.
          text: match.text.slice(0, 24_000),
          truncated: match.text.length > 24_000,
        });
      }

      case "compare_company": {
        const ticker = str(args, "ticker");
        const [meta, f] = await Promise.all([getProfileAndQuote(ticker), getFundamentals(ticker)]);
        if (!meta.profile) return JSON.stringify({ error: `Could not resolve ${ticker}` });
        const t = f.ttm ?? (f.annual ? f.annual[f.annual.length - 1] : undefined);
        return JSON.stringify({
          ticker,
          name: meta.profile.name,
          industry: meta.profile.industry ?? meta.profile.sector,
          price: meta.quote?.price,
          multiples: computeMultiples(ticker, t, meta.profile.marketCap, meta.quote?.price),
          latestPeriod: t,
          derived: f.derived?.slice(-1),
        });
      }

      case "run_dcf_scenario": {
        const ticker = str(args, "ticker");
        const [meta, f] = await Promise.all([getProfileAndQuote(ticker), getFundamentals(ticker)]);
        if (!f.annual?.length || !meta.profile?.marketCap || !meta.profile.sharesOutstanding) {
          return JSON.stringify({ error: `Insufficient data to model ${ticker}` });
        }

        const base = defaultAssumptions({
          annual: f.annual,
          ttmPeriod: f.ttm ?? undefined,
          marketCap: meta.profile.marketCap,
          dilutedShares: meta.profile.sharesOutstanding,
          beta: numOpt(args, "beta") ?? f.beta,
        });
        if (!base) return JSON.stringify({ error: "Could not build baseline assumptions" });

        const overrides: Partial<DcfAssumptions> = {};
        const rf = numOpt(args, "riskFreeRate");
        const tg = numOpt(args, "terminalGrowth");
        const tm = numOpt(args, "terminalOperatingMargin");
        const b = numOpt(args, "beta");
        const growth = Array.isArray(args.revenueGrowthYear1to5)
          ? (args.revenueGrowthYear1to5 as unknown[]).filter((v): v is number => typeof v === "number")
          : undefined;

        if (rf !== undefined) overrides.riskFreeRate = rf;
        if (tg !== undefined) overrides.terminalGrowth = tg;
        if (tm !== undefined) overrides.terminalOperatingMargin = tm;
        if (b !== undefined) overrides.beta = b;
        if (growth?.length) overrides.revenueGrowth = growth;

        const assumptions = { ...base, ...overrides };
        const latest = f.ttm ?? f.annual[f.annual.length - 1]!;
        if (!latest.revenue) return JSON.stringify({ error: "No revenue base for the projection" });
        const baseMargin = latest.operatingIncome ? latest.operatingIncome / latest.revenue : 0.1;

        const baseline = runDcf(latest.revenue, baseMargin, base);
        const scenario = runDcf(latest.revenue, baseMargin, assumptions);

        return JSON.stringify({
          ticker,
          currentPrice: meta.quote?.price,
          baseline: {
            intrinsicValuePerShare: Number(baseline.intrinsicValuePerShare.toFixed(2)),
            wacc: Number((baseline.wacc * 100).toFixed(2)),
          },
          scenario: {
            intrinsicValuePerShare: Number(scenario.intrinsicValuePerShare.toFixed(2)),
            wacc: Number((scenario.wacc * 100).toFixed(2)),
            changeVsBaselinePercent: baseline.intrinsicValuePerShare
              ? Number(
                  (
                    ((scenario.intrinsicValuePerShare - baseline.intrinsicValuePerShare) /
                      baseline.intrinsicValuePerShare) *
                    100
                  ).toFixed(1)
                )
              : null,
            warnings: scenario.warnings,
          },
          overridesApplied: overrides,
        });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}
