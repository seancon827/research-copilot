import { NextRequest } from "next/server";
import { getFilings, getFundamentals, getNews, getPeers, getProfileAndQuote } from "@/lib/research";
import { buildEvidence } from "@/lib/ai/evidence";
import * as A from "@/lib/ai/analysts";
import { defaultAssumptions, runDcf } from "@/lib/finance/dcf";
import { computeMultiples, marginOfSafety, relativeValuation } from "@/lib/finance/comps";
import type { ProviderAttempt } from "@/lib/types";

/**
 * The research pipeline, streamed as Server-Sent Events.
 *
 * Why SSE with *named section events* rather than one long text stream:
 * a research report is not one document, it is nine independent panels with very
 * different latencies. Retrieval takes ~2s, the filing map-reduce can take 40s.
 * Streaming named events lets each panel render the moment its own data is ready,
 * so the page is useful in two seconds instead of blank for a minute.
 *
 * Ordering matters and is deliberate: retrieval first, then the cheap panels,
 * then the expensive filing pass, then anything that depends on earlier output
 * (recommendation needs sentiment and valuation).
 *
 * Node runtime, not edge: the filing pass holds multi-megabyte strings in memory
 * and runs well past the edge CPU budget.
 */
export const runtime = "nodejs";
export const maxDuration = 300;

interface StreamController {
  send: (event: string, data: unknown) => void;
  close: () => void;
}

function sseStream(handler: (c: StreamController) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };

      try {
        await handler({ send, close });
      } catch (err) {
        send("error", { message: err instanceof Error ? err.message : String(err) });
      } finally {
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Disables proxy buffering, without which nothing reaches the browser
      // until the whole response completes and the streaming is pointless.
      "x-accel-buffering": "no",
    },
  });
}

export async function GET(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get("ticker") ?? "").trim().toUpperCase();

  if (!/^[A-Z][A-Z.-]{0,9}$/.test(ticker)) {
    return Response.json({ error: "Provide a valid ticker, e.g. ?ticker=AAPL" }, { status: 400 });
  }

  return sseStream(async ({ send }) => {
    const attempts: ProviderAttempt[] = [];
    const missing: string[] = [];

    /**
     * Run a stage in isolation. A failure emits an error event for that panel
     * only and returns undefined, so one dead section never takes the report
     * down. Returning the value (rather than mutating outer state) is what lets
     * later stages depend on earlier ones with real type safety.
     */
    const stage = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
      send("progress", { stage: name, status: "running" });
      try {
        const value = await fn();
        send("progress", { stage: name, status: "done" });
        return value;
      } catch (err) {
        missing.push(name);
        send("section_error", {
          section: name,
          message: err instanceof Error ? err.message : String(err),
        });
        send("progress", { stage: name, status: "failed" });
        return undefined;
      }
    };

    // ---- 1. Retrieval, all concurrent ------------------------------------
    send("progress", { stage: "retrieval", status: "running" });

    const [meta, fundamentals, newsResult, filingsResult, peerTickers] = await Promise.all([
      getProfileAndQuote(ticker),
      getFundamentals(ticker),
      getNews(ticker),
      getFilings(ticker),
      getPeers(ticker),
    ]);

    attempts.push(...meta.attempts, ...fundamentals.attempts, ...newsResult.attempts, ...filingsResult.attempts);

    if (!meta.profile) {
      send("error", {
        message: `Could not resolve ${ticker} with any configured data provider. Check the ticker and your API keys.`,
        attempts,
      });
      return;
    }

    send("profile", { profile: meta.profile, quote: meta.quote });
    send("diagnostics", { attempts });
    send("progress", { stage: "retrieval", status: "done" });

    if (fundamentals.annual) {
      send("financials", {
        annual: fundamentals.annual,
        quarterly: fundamentals.quarterly,
        derived: fundamentals.derived,
        ttm: fundamentals.ttm,
        earnings: fundamentals.earnings,
      });
    } else {
      missing.push("financials");
      send("section_error", {
        section: "financials",
        message: "No fundamentals available from any configured provider.",
      });
    }

    if (filingsResult.filings) send("filings_index", { filings: filingsResult.filings });
    if (newsResult.clusters) send("news_raw", { clusters: newsResult.clusters, rawCount: newsResult.rawCount });

    // ---- 2. Filing analysis (slowest, so start it now in the background) --
    // Kicked off before the cheap panels so its 30-60s runs in parallel with them.
    //
    // The task is settled into a result object rather than left as a rejectable
    // promise. Between creation here and the await further down there is no
    // handler attached, and a bare rejection in that window would surface as an
    // unhandled rejection and kill the worker rather than just failing a panel.
    const filingTask = (async () => {
      const target =
        filingsResult.filings?.find((f) => f.form === "10-K") ?? filingsResult.filings?.find((f) => f.form === "10-Q");
      if (!target) return { ok: false as const, error: "No 10-K or 10-Q found on EDGAR for this registrant." };
      try {
        const result = await A.summariseFiling(target);
        return { ok: true as const, value: { ...result, filing: target } };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    })();

    // ---- 3. News labelling ------------------------------------------------
    let labelledClusters = newsResult.clusters ?? [];
    await stage("news", async () => {
      if (labelledClusters.length === 0) throw new Error("No news retrieved for this ticker.");
      labelledClusters = await A.labelNews(labelledClusters);
      send("news", { clusters: labelledClusters });
    });

    // ---- 4. Deterministic valuation --------------------------------------
    // Computed before any model call touches valuation, so the model is
    // critiquing real arithmetic rather than producing it.
    const valuation = await stage("valuation", async () => {
      const annual = fundamentals.annual;
      if (!annual?.length) throw new Error("Valuation needs reported financials, which were not available.");
      if (!meta.profile?.marketCap || !meta.profile.sharesOutstanding) {
        throw new Error("Valuation needs market cap and share count, which were not available.");
      }

      const base = defaultAssumptions({
        annual,
        ttmPeriod: fundamentals.ttm ?? undefined,
        marketCap: meta.profile.marketCap,
        dilutedShares: meta.profile.sharesOutstanding,
        beta: fundamentals.beta,
      });
      if (!base) throw new Error("Could not construct DCF assumptions from the reported history.");

      const latest = fundamentals.ttm ?? annual[annual.length - 1]!;
      if (!latest.revenue) throw new Error("No revenue base available for the projection.");
      const baseMargin = latest.operatingIncome ? latest.operatingIncome / latest.revenue : 0.1;

      const dcf = runDcf(latest.revenue, baseMargin, base);

      const subject = computeMultiples(ticker, latest, meta.profile.marketCap, meta.quote?.price);
      const peerMultiples = await Promise.all(
        peerTickers.slice(0, 6).map(async (peer) => {
          try {
            const [pm, pf] = await Promise.all([getProfileAndQuote(peer), getFundamentals(peer)]);
            const pt = pf.ttm ?? (pf.annual ? pf.annual[pf.annual.length - 1] : undefined);
            return computeMultiples(peer, pt, pm.profile?.marketCap, pm.quote?.price);
          } catch {
            return null;
          }
        })
      );
      const usablePeers = peerMultiples.filter((p): p is NonNullable<typeof p> => p !== null);

      const mos = meta.quote?.price ? marginOfSafety(meta.quote.price, dcf.intrinsicValuePerShare) : undefined;

      send("valuation", {
        dcf,
        subject,
        peers: usablePeers,
        relative: relativeValuation(subject, latest, usablePeers),
        currentPrice: meta.quote?.price,
        marginOfSafetyPercent: mos,
      });

      return { dcf, marginOfSafety: mos };
    });

    // ---- 5. Await the filing pass ----------------------------------------
    const filingSections =
      (await stage("filings", async () => {
        const settled = await filingTask;
        if (!settled.ok) throw new Error(settled.error);
        const { summary, filing, sections } = settled.value;
        send("filings", { summary, filing, sections });
        return sections;
      })) ?? [];

    // ---- 6. Build the evidence pack --------------------------------------
    // Everything downstream is bounded by this pack and nothing else.
    const pack = buildEvidence({
      profile: meta.profile,
      quote: meta.quote,
      annual: fundamentals.annual,
      derived: fundamentals.derived,
      ttm: fundamentals.ttm,
      earnings: fundamentals.earnings,
      filings: filingsResult.filings,
      filingSections,
      newsClusters: labelledClusters,
    });

    send("evidence", { items: pack.all() });

    // ---- 7. Model analysis -----------------------------------------------
    await stage("overview", async () => {
      send("overview", await A.generateOverview(pack, ticker));
    });

    await stage("earnings", async () => {
      if (!fundamentals.earnings?.length) throw new Error("No earnings history retrieved.");
      send("earnings", await A.generateEarnings(pack, ticker));
    });

    const sentiment = await stage("sentiment", async () => {
      const result = await A.generateSentiment(pack, labelledClusters, ticker);
      send("sentiment", result);
      return result;
    });

    await stage("thesis", async () => {
      send("thesis", await A.generateThesis(pack, ticker));
    });

    await stage("valuation_commentary", async () => {
      if (!valuation) throw new Error("No DCF to critique — the valuation stage did not produce a model.");
      send("valuation_commentary", await A.critiqueValuation(pack, valuation.dcf, ticker));
    });

    await stage("recommendation", async () => {
      send(
        "recommendation",
        await A.generateRecommendation(pack, {
          ticker,
          sentimentConfidence: sentiment?.composite.confidence ?? 25,
          marginOfSafety: valuation?.marginOfSafety,
          missing,
        })
      );
    });

    send("complete", { missing, evidenceCount: pack.size, attempts });
  });
}
