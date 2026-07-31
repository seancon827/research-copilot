import { embed } from "../ai/client";
import type { NewsArticle, NewsCluster } from "../types";

/**
 * News deduplication and clustering.
 *
 * Financial news feeds are ~60% redundant: one Reuters story is syndicated to a
 * dozen outlets with a reworded headline. Feeding all of it to a model wastes
 * tokens and, worse, makes the model treat repetition as significance.
 *
 * Pipeline:
 *   1. Exact/near-exact dedupe on a normalised headline (cheap, catches syndication).
 *   2. Embed the survivors and run single-link agglomerative clustering on
 *      cosine similarity. Single-link is the right choice here: syndicated
 *      variants form chains (A~B, B~C) that centroid methods split apart.
 *   3. Score each cluster for importance, then rank.
 *
 * Importance is computed, not asked of a model — corroboration count and source
 * tier are objective signals and the arithmetic should be reproducible.
 */

const SIMILARITY_THRESHOLD = 0.84;

/** Outlets whose primary reporting tends to move prices. */
const TIER_1 = ["reuters", "bloomberg", "wall street journal", "wsj", "financial times", "dow jones", "associated press", "cnbc"];
const TIER_2 = ["barron", "marketwatch", "the information", "axios", "forbes", "business insider"];

function sourceTier(source: string): 1 | 2 | 3 {
  const s = source.toLowerCase();
  if (TIER_1.some((t) => s.includes(t))) return 1;
  if (TIER_2.some((t) => s.includes(t))) return 2;
  return 3;
}

function normaliseHeadline(headline: string): string {
  return headline
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    // Strip the wire-service furniture that makes identical stories look distinct.
    .replace(/\b(update|exclusive|breaking|analysis|reuters|bloomberg|shares|stock|inc|corp|the|a|an|of|to|in|on|for)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Union-find, used to materialise single-link clusters in near-linear time. */
class DisjointSet {
  private parent: number[];
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]!]!; // path halving
      i = this.parent[i]!;
    }
    return i;
  }
  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

export async function clusterNews(articles: NewsArticle[]): Promise<NewsCluster[]> {
  if (articles.length === 0) return [];

  // --- Stage 1: normalised-headline dedupe -------------------------------
  const seen = new Map<string, NewsArticle>();
  for (const article of articles) {
    const k = normaliseHeadline(article.headline);
    if (!k) continue;
    const existing = seen.get(k);
    // Keep the higher-tier outlet as the representative of a duplicate pair.
    if (!existing || sourceTier(article.source) < sourceTier(existing.source)) seen.set(k, article);
  }
  const unique = [...seen.values()];
  if (unique.length === 1) return [makeCluster("c0", unique[0]!, unique)];

  // --- Stage 2: embed and cluster ----------------------------------------
  let vectors: number[][] = [];
  try {
    vectors = await embed(unique.map((a) => `${a.headline}. ${a.summary?.slice(0, 300) ?? ""}`));
  } catch {
    // Embeddings unavailable: degrade to headline-dedupe only rather than fail
    // the whole news panel.
    return unique
      .map((a, i) => makeCluster(`c${i}`, a, [a]))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 20);
  }

  const ds = new DisjointSet(unique.length);
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      if (cosine(vectors[i] ?? [], vectors[j] ?? []) >= SIMILARITY_THRESHOLD) ds.union(i, j);
    }
  }

  const groups = new Map<number, NewsArticle[]>();
  unique.forEach((article, i) => {
    const root = ds.find(i);
    const bucket = groups.get(root);
    if (bucket) bucket.push(article);
    else groups.set(root, [article]);
  });

  // --- Stage 3: pick a lead and score ------------------------------------
  return [...groups.entries()]
    .map(([root, members]) => {
      const lead = [...members].sort((a, b) => {
        const tier = sourceTier(a.source) - sourceTier(b.source);
        if (tier !== 0) return tier;
        // Earliest publication within a tier is closest to the original report.
        return a.publishedAt.localeCompare(b.publishedAt);
      })[0]!;
      return makeCluster(`c${root}`, lead, members);
    })
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 20);
}

/**
 * Importance = corroboration + source quality + recency, each bounded.
 *
 *   corroboration (0-40): log-scaled so the 12th duplicate adds less than the 2nd
 *   source tier   (0-35): tier 1 primary reporting dominates
 *   recency       (0-25): exponential decay, 3-day half-life
 */
function makeCluster(id: string, lead: NewsArticle, members: NewsArticle[]): NewsCluster {
  const distinctSources = new Set(members.map((m) => m.source.toLowerCase())).size;
  const corroboration = Math.min(40, Math.log2(distinctSources + 1) * 18);

  const bestTier = Math.min(...members.map((m) => sourceTier(m.source)));
  const tierScore = bestTier === 1 ? 35 : bestTier === 2 ? 22 : 10;

  const ageHours = Math.max(0, (Date.now() - new Date(lead.publishedAt).getTime()) / 3_600_000);
  const recency = 25 * Math.pow(0.5, ageHours / 72);

  return {
    id,
    lead,
    members: members.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)),
    importance: Math.round(corroboration + tierScore + recency),
  };
}
