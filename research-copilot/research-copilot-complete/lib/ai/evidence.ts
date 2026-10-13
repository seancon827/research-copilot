import type {
  CompanyProfile,
  DerivedMetrics,
  EarningsEvent,
  Evidence,
  FinancialPeriod,
  Filing,
  NewsCluster,
  Quote,
} from "../types";

/**
 * GROUNDING.
 *
 * The brief said "never hallucinate". No prompt can promise that, so this file
 * implements the enforceable version of the requirement:
 *
 *  1. The model sees a closed set of numbered evidence items and nothing else.
 *     It is not asked to recall anything about the company from pre-training.
 *  2. Every factual sentence must carry a citation id like [F3].
 *  3. After generation we *verify* the citations against the pack. Ids that do
 *     not exist are stripped and recorded as `invalidCitations`, and any
 *     sentence left with no citation is flagged as unsupported. The UI renders
 *     those flags rather than hiding them.
 *
 * The result is not a guarantee of truth. It is a guarantee that any factual
 * claim is either traceable to a retrieved source or visibly marked as
 * unsupported — which is the property an analyst actually needs.
 */

export class EvidencePack {
  private items: Evidence[] = [];
  private counters: Record<string, number> = {};

  private nextId(prefix: string): string {
    this.counters[prefix] = (this.counters[prefix] ?? 0) + 1;
    return `${prefix}${this.counters[prefix]}`;
  }

  add(kind: Evidence["kind"], text: string, opts: { url?: string; provider: string; asOf: string }): Evidence {
    const prefix = { financial: "F", news: "N", filing: "S", earnings: "E", quote: "Q", profile: "P", computed: "C" }[
      kind
    ];
    const item: Evidence = { id: this.nextId(prefix), kind, text, ...opts };
    this.items.push(item);
    return item;
  }

  /** Rebuild a pack from serialised evidence, so the chat route can verify
   *  citations against exactly the ids the report was generated from. */
  static hydrate(items: Evidence[]): EvidencePack {
    const pack = new EvidencePack();
    pack.items = [...items];
    return pack;
  }

  all(): Evidence[] {
    return this.items;
  }

  has(id: string): boolean {
    return this.items.some((i) => i.id === id);
  }

  /** The block injected into the prompt. Compact, one line per item. */
  render(): string {
    if (this.items.length === 0) return "(no evidence retrieved)";
    return this.items.map((i) => `[${i.id}] (${i.provider}, as of ${i.asOf.slice(0, 10)}) ${i.text}`).join("\n");
  }

  get size(): number {
    return this.items.length;
  }
}

const fmtMoney = (v: number | undefined, currency = "USD"): string => {
  if (v === undefined) return "n/a";
  const abs = Math.abs(v);
  const unit = abs >= 1e12 ? ["T", 1e12] : abs >= 1e9 ? ["B", 1e9] : abs >= 1e6 ? ["M", 1e6] : ["", 1];
  return `${v < 0 ? "-" : ""}${currency === "USD" ? "$" : ""}${(abs / (unit[1] as number)).toFixed(2)}${unit[0]}`;
};
const fmtPct = (v: number | undefined): string => (v === undefined ? "n/a" : `${v.toFixed(1)}%`);

/**
 * Turn retrieved data into evidence. Only facts we actually hold get an id, so
 * a gap in the data becomes an absent citation rather than an invented number.
 */
export function buildEvidence(input: {
  profile?: CompanyProfile | null;
  quote?: Quote | null;
  annual?: FinancialPeriod[] | null;
  derived?: DerivedMetrics[] | null;
  ttm?: FinancialPeriod | null;
  earnings?: EarningsEvent[] | null;
  filings?: Filing[] | null;
  filingSections?: { label: string; summary: string; url: string; filedAt: string }[] | null;
  newsClusters?: NewsCluster[] | null;
}): EvidencePack {
  const pack = new EvidencePack();
  const now = new Date().toISOString();

  if (input.profile) {
    const p = input.profile;
    pack.add(
      "profile",
      `${p.name} (${p.ticker}) is listed on ${p.exchange ?? "an unspecified exchange"} in ${
        p.industry ?? p.sector ?? "an unspecified industry"
      }. Market capitalisation ${fmtMoney(p.marketCap)}${
        p.employees ? `, ${p.employees.toLocaleString()} employees` : ""
      }.`,
      { provider: "profile", asOf: now, url: p.website }
    );
    if (p.description) {
      pack.add("profile", `Business description (as filed): ${p.description.slice(0, 900)}`, {
        provider: "profile",
        asOf: now,
      });
    }
  }

  if (input.quote) {
    const q = input.quote;
    pack.add(
      "quote",
      `Last price ${q.price.toFixed(2)}, change ${q.change >= 0 ? "+" : ""}${q.change.toFixed(2)} (${q.changePercent.toFixed(
        2
      )}%)${
        q.fiftyTwoWeekHigh && q.fiftyTwoWeekLow
          ? `; 52-week range ${q.fiftyTwoWeekLow.toFixed(2)}–${q.fiftyTwoWeekHigh.toFixed(2)}`
          : ""
      }.`,
      { provider: "market data", asOf: now }
    );
  }

  // One evidence row per fiscal year keeps the pack compact while still letting
  // the model cite a specific period rather than "recent results".
  for (const period of (input.annual ?? []).slice(-5)) {
    const d = input.derived?.find((m) => m.period === period.period);
    pack.add(
      "financial",
      `${period.period} (ended ${period.endDate}): revenue ${fmtMoney(period.revenue)}, operating income ${fmtMoney(
        period.operatingIncome
      )}, net income ${fmtMoney(period.netIncome)}, diluted EPS ${
        period.epsDiluted?.toFixed(2) ?? "n/a"
      }, free cash flow ${fmtMoney(period.freeCashFlow)}. Gross margin ${fmtPct(
        d?.grossMargin
      )}, operating margin ${fmtPct(d?.operatingMargin)}, ROE ${fmtPct(d?.roe)}, ROIC ${fmtPct(
        d?.roic
      )}, revenue growth ${fmtPct(d?.revenueGrowthYoY)}.`,
      { provider: "fundamentals", asOf: now }
    );
  }

  if (input.ttm) {
    const t = input.ttm;
    pack.add(
      "financial",
      `Trailing twelve months: revenue ${fmtMoney(t.revenue)}, EBITDA ${fmtMoney(t.ebitda)}, net income ${fmtMoney(
        t.netIncome
      )}, free cash flow ${fmtMoney(t.freeCashFlow)}, total debt ${fmtMoney(t.totalDebt)}, cash and short-term investments ${fmtMoney(
        (t.cashAndEquivalents ?? 0) + (t.shortTermInvestments ?? 0)
      )}.`,
      { provider: "fundamentals (TTM, computed)", asOf: now }
    );
  }

  for (const e of (input.earnings ?? []).slice(0, 4)) {
    const beat =
      e.epsActual !== undefined && e.epsEstimate !== undefined
        ? e.epsActual >= e.epsEstimate
          ? "beat"
          : "missed"
        : "unknown vs";
    pack.add(
      "earnings",
      `${e.period} reported ${e.reportDate}: EPS ${e.epsActual?.toFixed(2) ?? "n/a"} vs consensus ${
        e.epsEstimate?.toFixed(2) ?? "n/a"
      } — ${beat} estimates${
        e.epsSurprisePercent !== undefined ? ` by ${e.epsSurprisePercent.toFixed(1)}%` : ""
      }.`,
      { provider: "earnings", asOf: now }
    );
  }

  for (const section of input.filingSections ?? []) {
    pack.add("filing", `${section.label} (filed ${section.filedAt}): ${section.summary}`, {
      provider: "SEC EDGAR",
      asOf: section.filedAt,
      url: section.url,
    });
  }

  for (const filing of (input.filings ?? []).slice(0, 6)) {
    pack.add("filing", `${filing.form} filed ${filing.filedAt}${filing.reportPeriod ? ` for period ending ${filing.reportPeriod}` : ""}.`, {
      provider: "SEC EDGAR",
      asOf: filing.filedAt,
      url: filing.primaryDocUrl,
    });
  }

  for (const cluster of (input.newsClusters ?? []).slice(0, 12)) {
    pack.add(
      "news",
      `${cluster.lead.headline} (${cluster.lead.source}, ${cluster.lead.publishedAt.slice(0, 10)})${
        cluster.members.length > 1 ? ` — corroborated by ${cluster.members.length - 1} other outlet(s)` : ""
      }${cluster.summary ? `. ${cluster.summary}` : ""}`,
      { provider: cluster.lead.source, asOf: cluster.lead.publishedAt, url: cluster.lead.url }
    );
  }

  return pack;
}

// --------------------------------------------------------------------------
// Verification
// --------------------------------------------------------------------------

const CITE_RE = /\[([A-Z]\d{1,3}(?:\s*,\s*[A-Z]\d{1,3})*)\]/g;

export interface VerifiedText {
  text: string;
  usedIds: string[];
  invalidCitations: string[];
  /** Sentences that assert something factual but carry no valid citation. */
  unsupportedSentences: string[];
}

/**
 * Verify and clean model output.
 *
 * Sentences are only flagged when they look like factual assertions — they
 * contain a digit, a currency symbol or a percentage. Purely qualitative
 * framing ("the competitive position appears durable") is opinion and is not
 * required to carry a citation; forcing citations onto opinion just teaches the
 * model to attach ids at random, which is worse than no check at all.
 */
export function verify(raw: string, pack: EvidencePack): VerifiedText {
  const invalid = new Set<string>();
  const used = new Set<string>();

  const cleaned = raw.replace(CITE_RE, (match, group: string) => {
    const ids = group.split(",").map((s) => s.trim());
    const valid = ids.filter((id) => {
      if (pack.has(id)) {
        used.add(id);
        return true;
      }
      invalid.add(id);
      return false;
    });
    return valid.length ? `[${valid.join(", ")}]` : "";
  });

  const unsupported: string[] = [];
  for (const sentence of cleaned.split(/(?<=[.!?])\s+/)) {
    const trimmed = sentence.trim();
    if (trimmed.length < 25) continue;
    const looksFactual = /\d|[$€£¥]|%/.test(trimmed);
    const hasCitation = /\[[A-Z]\d/.test(trimmed);
    if (looksFactual && !hasCitation) unsupported.push(trimmed.slice(0, 220));
  }

  return {
    text: cleaned.replace(/\s{2,}/g, " ").trim(),
    usedIds: [...used],
    invalidCitations: [...invalid],
    unsupportedSentences: unsupported,
  };
}
