/**
 * Section extraction from 10-K / 10-Q text.
 *
 * The hard part is not finding "Item 1A. Risk Factors" — it appears at least
 * twice in every filing, once in the table of contents and once as the real
 * heading. A naive `indexOf` lands in the TOC and returns a two-line section.
 *
 * Strategy: collect *all* occurrences of each item heading, then for each
 * candidate start compute the distance to the next item heading that follows it.
 * The real body is the candidate with the largest span. This is robust to
 * filings with multiple TOCs, cross-references and exhibit indexes.
 */

export type SectionKey =
  | "business"
  | "riskFactors"
  | "legalProceedings"
  | "mdna"
  | "marketRisk"
  | "liquidity"
  | "controls";

interface Pattern {
  key: SectionKey;
  label: string;
  /** Matches the heading at the start of a line. */
  re: RegExp;
}

const TEN_K: Pattern[] = [
  { key: "business", label: "Item 1 — Business", re: /^\s*item\s*1\s*[.:—-]?\s*business/im },
  { key: "riskFactors", label: "Item 1A — Risk Factors", re: /^\s*item\s*1a\s*[.:—-]?\s*risk\s*factors/im },
  {
    key: "legalProceedings",
    label: "Item 3 — Legal Proceedings",
    re: /^\s*item\s*3\s*[.:—-]?\s*legal\s*proceedings/im,
  },
  {
    key: "mdna",
    label: "Item 7 — Management's Discussion & Analysis",
    re: /^\s*item\s*7\s*[.:—-]?\s*management/im,
  },
  {
    key: "marketRisk",
    label: "Item 7A — Quantitative & Qualitative Disclosures About Market Risk",
    re: /^\s*item\s*7a\s*[.:—-]?\s*quantitative/im,
  },
  { key: "controls", label: "Item 9A — Controls & Procedures", re: /^\s*item\s*9a\s*[.:—-]?\s*controls/im },
];

const TEN_Q: Pattern[] = [
  {
    key: "mdna",
    label: "Item 2 — Management's Discussion & Analysis",
    re: /^\s*item\s*2\s*[.:—-]?\s*management/im,
  },
  { key: "riskFactors", label: "Item 1A — Risk Factors", re: /^\s*item\s*1a\s*[.:—-]?\s*risk\s*factors/im },
  {
    key: "legalProceedings",
    label: "Item 1\u00a0— Legal Proceedings",
    re: /^\s*item\s*1\s*[.:—-]?\s*legal\s*proceedings/im,
  },
  {
    key: "marketRisk",
    label: "Item 3 — Quantitative & Qualitative Disclosures About Market Risk",
    re: /^\s*item\s*3\s*[.:—-]?\s*quantitative/im,
  },
];

/** Any item heading — used as a terminator when slicing a section. */
const ANY_ITEM = /^\s*item\s*\d{1,2}[a-c]?\s*[.:—-]/gim;

export interface Section {
  key: SectionKey;
  label: string;
  text: string;
  /** Character offset in the source document, so citations can deep-link. */
  offset: number;
}

function allMatches(text: string, re: RegExp): number[] {
  const global = new RegExp(re.source, "gim");
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = global.exec(text)) !== null) {
    out.push(m.index);
    if (global.lastIndex === m.index) global.lastIndex++; // guard zero-width
  }
  return out;
}

export function extractSections(text: string, form: string): Section[] {
  const patterns = form.startsWith("10-Q") ? TEN_Q : TEN_K;

  // Every item-heading offset in the document, sorted. Section bodies end at
  // the next heading regardless of which item it is.
  const boundaries = allMatches(text, ANY_ITEM).sort((a, b) => a - b);

  const sections: Section[] = [];

  for (const pattern of patterns) {
    const candidates = allMatches(text, pattern.re);
    if (candidates.length === 0) continue;

    let best = { start: -1, end: -1, span: 0 };
    for (const start of candidates) {
      const next = boundaries.find((b) => b > start + 40); // skip the heading itself
      const end = next ?? Math.min(text.length, start + 200_000);
      const span = end - start;
      if (span > best.span) best = { start, end, span };
    }

    // Below ~600 chars we only found a TOC row or a cross-reference.
    if (best.span < 600) continue;

    sections.push({
      key: pattern.key,
      label: pattern.label,
      text: text.slice(best.start, best.end).replace(/\n{3,}/g, "\n\n").trim(),
      offset: best.start,
    });
  }

  // Liquidity is a sub-heading inside MD&A, not its own Item, so it needs a
  // separate pass over the MD&A body.
  const mdna = sections.find((s) => s.key === "mdna");
  if (mdna) {
    const liq = /liquidity\s+and\s+capital\s+resources/i.exec(mdna.text);
    if (liq) {
      sections.push({
        key: "liquidity",
        label: "Liquidity & Capital Resources",
        text: mdna.text.slice(liq.index, liq.index + 30_000).trim(),
        offset: mdna.offset + liq.index,
      });
    }
  }

  return sections;
}

/**
 * Split a section into overlapping chunks sized for a map-reduce summarisation
 * pass. Boundaries are pushed to paragraph breaks so a chunk never starts
 * mid-sentence, which measurably improves summary quality.
 *
 * ~4 chars/token is the standard English approximation; we size in characters
 * to avoid shipping a tokenizer to the edge.
 */
export function chunk(text: string, targetChars = 12_000, overlapChars = 600): string[] {
  if (text.length <= targetChars) return [text];

  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    let end = Math.min(text.length, cursor + targetChars);

    if (end < text.length) {
      // Prefer a paragraph break, then a sentence end, within the last 15%.
      const window = text.slice(end - Math.floor(targetChars * 0.15), end);
      const para = window.lastIndexOf("\n\n");
      const sentence = window.lastIndexOf(". ");
      const adjust = para > 0 ? para : sentence > 0 ? sentence + 1 : -1;
      if (adjust > 0) end = end - window.length + adjust;
    }

    chunks.push(text.slice(cursor, end).trim());
    if (end >= text.length) break;
    cursor = Math.max(cursor + 1, end - overlapChars);
  }

  return chunks.filter((c) => c.length > 200);
}
