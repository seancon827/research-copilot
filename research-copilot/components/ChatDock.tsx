"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Pill } from "./primitives";
import type { Evidence } from "@/lib/types";

/**
 * The chat dock.
 *
 * Two decisions worth noting:
 *  - Tool calls are shown as they happen. When the model goes off to read a
 *    10-Q, the user sees "reading 10-K risk factors" rather than a spinner. In a
 *    research tool, showing the work is the product.
 *  - The evidence pack from the current report is sent with every message, so
 *    chat answers cite the same ids as the report and the user can cross-check
 *    against the same drawer.
 */

interface Turn {
  role: "user" | "assistant";
  content: string;
  tools?: { name: string; args: unknown }[];
}

const SUGGESTIONS = [
  "What are the biggest risks?",
  "Compare to MSFT",
  "Summarise the last quarter",
  "What happens if rates rise 200bps?",
];

const TOOL_LABELS: Record<string, string> = {
  get_financials: "pulling financials",
  get_filing_section: "reading a filing section",
  compare_company: "fetching comparison data",
  run_dcf_scenario: "re-running the DCF",
};

export function ChatDock({ ticker, evidence }: { ticker: string; evidence: Evidence[] }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, busy]);

  async function send(message: string) {
    const question = message.trim();
    if (!question || busy) return;

    setError(null);
    setInput("");
    setBusy(true);

    // Snapshot history before appending, so the request carries prior turns only.
    const history = turns.map((t) => ({ role: t.role, content: t.content }));
    setTurns((t) => [...t, { role: "user", content: question }, { role: "assistant", content: "", tools: [] }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticker, message: question, history, evidence }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`Chat request failed with ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

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

          if (event === "delta") {
            const text = String(payload.text ?? "");
            setTurns((t) => {
              const next = [...t];
              const last = next[next.length - 1];
              if (last?.role === "assistant") next[next.length - 1] = { ...last, content: last.content + text };
              return next;
            });
          } else if (event === "tool") {
            setTurns((t) => {
              const next = [...t];
              const last = next[next.length - 1];
              if (last?.role === "assistant") {
                next[next.length - 1] = {
                  ...last,
                  tools: [...(last.tools ?? []), { name: String(payload.name), args: payload.args }],
                };
              }
              return next;
            });
          } else if (event === "error") {
            setError(String(payload.message ?? "The chat stream failed."));
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-term-line bg-term-panel">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2 hover:bg-term-raised"
      >
        <span className="label text-infer">Research chat</span>
        <span className="label ml-auto">{open ? "collapse" : "expand"}</span>
      </button>

      {open && (
        <>
          <div ref={scrollRef} className="max-h-[42vh] min-h-[120px] overflow-y-auto border-t border-term-line">
            {turns.length === 0 ? (
              <div className="p-4">
                <p className="text-sm text-term-dim">
                  Ask about {ticker}. Answers are bounded by the {evidence.length} retrieved evidence items and by live
                  tool calls — never by the model&apos;s recollection.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void send(s)}
                      className="rounded-sm border border-term-line px-2 py-1 font-mono text-2xs text-term-dim transition-colors hover:border-infer/50 hover:text-infer"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <ul className="divide-y divide-term-line">
                {turns.map((turn, i) => (
                  <li key={i} className="px-4 py-3">
                    <div className="mb-1 flex items-center gap-2">
                      <span className={clsx("label", turn.role === "user" ? "text-fact" : "text-infer")}>
                        {turn.role === "user" ? "you" : "copilot"}
                      </span>
                      {turn.tools?.map((t, j) => (
                        <Pill key={j} tone="neutral">{TOOL_LABELS[t.name] ?? t.name}</Pill>
                      ))}
                    </div>
                    <p className={clsx("whitespace-pre-wrap", turn.role === "user" ? "font-mono text-xs text-term-text" : "prose-ai")}>
                      {turn.content}
                      {busy && i === turns.length - 1 && turn.role === "assistant" && (
                        <span className="ml-0.5 inline-block h-3 w-[2px] animate-pulse-line bg-infer align-middle" />
                      )}
                    </p>
                  </li>
                ))}
              </ul>
            )}

            {error && (
              <div className="border-t border-term-line bg-down/5 px-4 py-2">
                <p className="font-mono text-2xs text-down">{error}</p>
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
            className="flex items-center gap-2 border-t border-term-line px-3 py-2"
          >
            <span className="font-mono text-xs text-infer" aria-hidden>
              ›
            </span>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`Ask about ${ticker}…`}
              disabled={busy}
              className="flex-1 bg-transparent font-mono text-xs text-term-bright placeholder:text-term-dim focus:outline-none disabled:opacity-50"
              aria-label="Ask a research question"
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="rounded-sm border border-infer/40 bg-infer/10 px-2.5 py-1 font-mono text-2xs uppercase tracking-wider text-infer transition-colors hover:bg-infer/20 disabled:opacity-40"
            >
              {busy ? "thinking" : "ask"}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
