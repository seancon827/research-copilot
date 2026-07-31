# AI Research Copilot

Enter a ticker, get a sourced equity research report. Retrieval across four data providers, deterministic valuation, and model analysis that is bounded to a closed evidence set with programmatically verified citations.

```
/AAPL  →  10-stage pipeline  →  streamed report + research chat
```

---

## The one idea this project is built around

Language models are good at synthesis and bad at arithmetic and recall. So the architecture splits the work along that line and never crosses it:

| Layer | Who does it | Why |
|---|---|---|
| Retrieval | Providers with failover | Vendors disagree and go down |
| Ratios, DCF, sentiment blend, news ranking | **TypeScript** | Must be reproducible and auditable |
| Prose, judgement, assumption critique | **Model** | Genuinely what it is good at |
| Citation verification | **TypeScript** | The model cannot be its own auditor |

The visible consequence: **monospace + amber means a retrieved number, sans-serif + cyan means a model wrote it.** A reader never has to wonder which they are looking at.

---

## Three places I deliberately did not follow the brief

**1. "Never hallucinate" is not implementable as written — so I implemented the enforceable version.**
No prompt can guarantee truthfulness. What *can* be guaranteed is traceability. The model receives a numbered evidence pack (`lib/ai/evidence.ts`) and is told it is the entire world. Every factual sentence must cite ids. After generation, `verify()` checks each id against the pack: unknown ids are stripped, and any sentence containing a number with no surviving citation is flagged `UNSUPPORTED` in red in the UI. The guarantee is *"every figure is either traceable or visibly marked as untraceable"* — which is the property an analyst actually needs.

**2. The DCF is plain TypeScript, not a model call.**
A model asked to "do a DCF" produces arithmetic that looks right, is often wrong, and cannot be audited. `lib/finance/dcf.ts` is a two-stage FCFF model with CAPM WACC, a margin glide path, a Gordon terminal value, and a 5×5 sensitivity grid. Same inputs, same output, every time. The model's only valuation job is critiquing the *assumptions* against reported history — which is the part that needs judgement. Every assumption ships with a `provenance` string saying where it came from, rendered in the UI.

**3. "GPT-5.5" — I could not verify that model exists.**
So no model name is hardcoded anywhere. `OPENAI_MODEL` is read from env with a documented fallback. Set it to whatever the newest model you have access to is; upgrading is a config change, not a code change.

Two smaller ones worth flagging: the composite sentiment score and the news importance ranking are also computed in code, not asked of the model. Channel weights (filings 40% / earnings 35% / news 25%) and confidence-falls-as-channels-disagree are stated in the UI. And the "Recommendation" is framed as research output with a data-quality caveat, not advice.

---

## Folder structure

```
research-copilot/
├── app/
│   ├── layout.tsx                  Font wiring (IBM Plex Mono for data, Inter for prose)
│   ├── globals.css                 Design tokens + the provenance colour system
│   ├── page.tsx                    Landing page; the hero is the pipeline itself
│   ├── [ticker]/page.tsx           The report. Tabs, progress rail, panel composition
│   └── api/
│       ├── research/route.ts       ★ The pipeline. SSE, one named event per section
│       └── chat/route.ts           ★ Streaming chat with a bounded tool-calling loop
│
├── lib/
│   ├── env.ts                      Zod-validated env + capability detection
│   ├── http.ts                     Retry w/ jitter, timeouts, typed ProviderError
│   ├── cache.ts                    ★ TTL cache + in-flight coalescing (see note below)
│   ├── types.ts                    Domain model. Note `Sourced<T>`
│   ├── format.ts                   Display formatting; absence always renders as —
│   ├── research.ts                 Orchestrates providers, returns data + attempt log
│   ├── useResearchStream.ts        Client SSE consumer → typed state, single reducer
│   │
│   ├── providers/
│   │   ├── failover.ts             Ordered failover, records every attempt
│   │   ├── finnhub.ts              Primary. XBRL concept resolution lives here
│   │   ├── alphaVantage.ts         Fundamentals fallback
│   │   ├── yahoo.ts                Keyless last resort + price history
│   │   └── edgar.ts                ★ CIK resolution, rate limiting, HTML→text
│   │
│   ├── sec/sections.ts             ★ Item extraction (the TOC problem) + chunking
│   ├── news/cluster.ts             ★ Embedding dedupe, single-link clustering, ranking
│   │
│   ├── finance/
│   │   ├── metrics.ts              Ratios derived locally, never vendor-supplied
│   │   ├── dcf.ts                  ★ The valuation model
│   │   └── comps.ts                Multiples, peer medians, margin of safety
│   │
│   └── ai/
│       ├── client.ts               Model wrapper: JSON repair loop, cached embeddings
│       ├── evidence.ts             ★ Evidence pack + citation verifier
│       ├── schemas.ts              Zod schemas for every structured output
│       ├── prompts.ts              The grounding preamble does the heavy lifting
│       ├── analysts.ts             ★ Map-reduce filing pass + section generators
│       └── tools.ts                Function calling. Tools return data, never prose
│
└── components/
    ├── primitives.tsx              Panel, Metric, Skeleton, Cite, EvidenceList
    ├── CompanyHeader.tsx           Identity, quote, rating, 52-week position
    ├── Sidebar.tsx                 Search, watchlist, history, theme
    ├── ChatDock.tsx                Streaming chat with live tool-call visibility
    └── panels/
        ├── Financials.tsx          Charts + derived ratio table
        ├── Analysis.tsx            Overview, sentiment, thesis, rating, earnings
        ├── Valuation.tsx           DCF, sensitivity heatmap, comps, provenance
        └── NewsAndFilings.tsx      Clusters w/ corroboration counts; filing summary

★ = where the non-obvious engineering is. Start with api/research/route.ts.
```

### The five files worth reading first

1. **`app/api/research/route.ts`** — why the report streams as *named section events* rather than one text blob: nine stages with latencies from 2s to 60s, so each panel renders when its own data lands.
2. **`lib/ai/evidence.ts`** — the grounding contract and the citation verifier.
3. **`lib/finance/dcf.ts`** — the valuation model, and why the sensitivity grid is the honest output.
4. **`lib/sec/sections.ts`** — "Item 1A. Risk Factors" appears in every 10-K at least twice. A naive `indexOf` lands in the table of contents and returns two lines. The fix: collect all occurrences, slice each to the next Item heading, keep the longest span.
5. **`lib/cache.ts`** — a plain TTL cache does *not* prevent duplicate API calls, because nothing is cached until the first call returns. The in-flight promise map is what actually does it.

---

## Installation

Requires Node 18.17+.

```bash
npm install
cp .env.example .env.local   # then fill in keys, see below
npm run dev                  # http://localhost:3000
npm run typecheck            # tsc --noEmit
```

Then open `http://localhost:3000/AAPL`.

**Not yet run against live APIs.** This was built in an environment without network access, so `npm install` and `tsc` have not been executed and no request has hit a real provider. Expect to spend an hour on first-run fixes — most likely in the Finnhub XBRL concept mapping (`lib/providers/finnhub.ts`), where tag names vary by filer, and in `htmlToText` against unusual filing markup. The failover and error paths are built precisely because these are the parts that break.

---

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `OPENAI_API_KEY` | **Yes** | The only key the app refuses to boot without |
| `OPENAI_MODEL` | No | Defaults to `gpt-4.1`. Set to the newest you have |
| `OPENAI_EMBED_MODEL` | No | `text-embedding-3-small`. Used for news clustering |
| `FINNHUB_API_KEY` | Strongly recommended | Best free-tier coverage; profile + fundamentals + news + earnings + peers in one key |
| `ALPHAVANTAGE_API_KEY` | No | Fundamentals fallback. Free tier is 25 req/day — hence the aggressive caching |
| `POLYGON_API_KEY` | No | Wired into env and capability detection; no provider module yet |
| `SEC_USER_AGENT` | Recommended | SEC returns 403 without a real contact address. Use `"Your Name (you@example.com)"` |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | No | Shared cache across serverless instances. Without it, cache is per-instance and cold-starts |

Missing data-provider keys do not crash the app. `lib/env.ts` detects capabilities, failover skips unconfigured providers with `"not configured"` in the attempt log, and the UI status rail shows exactly which vendor served each number.

---

## Deploying to Vercel

```bash
npm i -g vercel
vercel
vercel env add OPENAI_API_KEY production   # repeat per variable
vercel --prod
```

Three things that matter on Vercel specifically:

- **Both API routes are `runtime = "nodejs"`, not edge.** The filing pass holds multi-megabyte strings and runs well past the edge CPU budget.
- **`maxDuration = 300` on `/api/research`.** A full report with a cold 10-K takes 60–120s. Hobby plans cap at 60s — the report will truncate mid-stream. Use Pro, or drop the filing stage.
- **Add Upstash if you deploy seriously.** Serverless instances do not share memory, so the in-process cache cold-starts constantly and you will burn Alpha Vantage's 25 daily requests fast.

---

## What is not built

Being explicit, since the brief listed these:

- **PDF / Excel export, one-click memo** — the report state is already fully serialisable, so this is a rendering job, not an architecture one.
- **Portfolio tracker** — needs auth and a real database. Watchlist and history use `localStorage`, isolated behind two hooks in `Sidebar.tsx` so swapping in a backend is a one-file change. This was a scope call: auth would have been the largest single piece of work here and would demonstrate nothing about AI engineering or finance.
- **Earnings call transcripts** — no free source. This is the biggest genuine gap: sections 3's "management commentary" and "key quotes" are structurally unavailable, and the prompt explicitly instructs the model to say so rather than reconstruct plausible-sounding quotes. `lib/ai/prompts.ts`, `EARNINGS_PROMPT`.
- **Polygon provider module** — env plumbing exists, module does not.
- **Tests** — `dcf.ts`, `metrics.ts`, `cluster.ts` and `sections.ts` are all pure functions written to be testable. Their absence is the first thing I would fix.

---

## Future improvements, in the order I would do them

1. **Unit tests on the deterministic layer.** A DCF with no test suite is a liability. Golden-file tests on `extractSections` against a handful of real 10-Ks would catch the highest-risk parser silently.
2. **Live risk-free rate** from FRED, replacing the static 4.3%. Currently the single least defensible number in the model, and it is flagged as such in the assumptions panel.
3. **Segment-level revenue** from XBRL dimensional data. Right now revenue mix comes from filing prose, which is why `sharePercent` is so often `null`.
4. **Assumption overrides in the UI.** The DCF already accepts arbitrary assumptions and the chat can already re-run scenarios via `run_dcf_scenario`; it needs sliders wired to the same function.
5. **Filing diffs.** Year-over-year change in Risk Factors language is where the real signal is, and the current `notableChanges` field asks the model to guess at it without the prior filing in context.
6. **Move the filing pass to a queue.** It is the one stage that does not fit a request/response lifecycle. Inngest or QStash, with the report page subscribing to results.
7. **Evaluation harness.** Fixed ticker set, known-answer questions, measure citation validity rate and unsupported-claim rate per model version. Without this, "did the upgrade help?" is unanswerable.

---

## Disclaimer

Research tooling, not investment advice. Ratings are generated by a language model from retrieved public data and are not a recommendation to buy or sell any security. Data may be stale, incomplete, or wrong.
