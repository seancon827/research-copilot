"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { relativeTime } from "@/lib/format";

/**
 * Watchlist and history are stored in localStorage.
 *
 * This is a deliberate MVP scope decision, not an oversight: adding auth and a
 * database would be the single largest piece of work in this project and would
 * demonstrate nothing about AI engineering or financial analysis. The storage
 * layer is isolated behind these two hooks so swapping in a real backend is a
 * one-file change.
 */

const WATCHLIST_KEY = "rc:watchlist";
const HISTORY_KEY = "rc:history";

interface HistoryEntry {
  ticker: string;
  name?: string;
  viewedAt: string;
}

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota exceeded or private mode — non-fatal */
  }
}

export function useWatchlist() {
  const [tickers, setTickers] = useState<string[]>([]);

  // Read after mount, not during render: localStorage is unavailable during SSR
  // and touching it in the initial state causes a hydration mismatch.
  useEffect(() => setTickers(readJson<string[]>(WATCHLIST_KEY, [])), []);

  const toggle = (ticker: string) => {
    setTickers((current) => {
      const upper = ticker.toUpperCase();
      const next = current.includes(upper) ? current.filter((t) => t !== upper) : [upper, ...current].slice(0, 40);
      writeJson(WATCHLIST_KEY, next);
      return next;
    });
  };

  return { tickers, toggle, has: (t: string) => tickers.includes(t.toUpperCase()) };
}

export function recordVisit(ticker: string, name?: string) {
  const history = readJson<HistoryEntry[]>(HISTORY_KEY, []);
  const filtered = history.filter((h) => h.ticker !== ticker.toUpperCase());
  writeJson(HISTORY_KEY, [{ ticker: ticker.toUpperCase(), name, viewedAt: new Date().toISOString() }, ...filtered].slice(0, 30));
}

export function Sidebar({ activeTicker }: { activeTicker?: string }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const { tickers, toggle, has } = useWatchlist();

  useEffect(() => {
    setHistory(readJson<HistoryEntry[]>(HISTORY_KEY, []));
  }, [activeTicker]);

  const go = (ticker: string) => {
    const clean = ticker.trim().toUpperCase();
    if (/^[A-Z][A-Z.-]{0,9}$/.test(clean)) router.push(`/${clean}`);
  };

  return (
    <aside className="flex h-full w-full shrink-0 flex-col border-r border-term-line bg-term-panel lg:w-60">
      <div className="border-b border-term-line px-4 py-3">
        <p className="font-mono text-sm font-semibold tracking-tight text-fact">RESEARCH COPILOT</p>
        <p className="mt-0.5 font-mono text-2xs text-term-dim">evidence-bounded equity research</p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          go(query);
          setQuery("");
        }}
        className="border-b border-term-line px-3 py-2.5"
      >
        <label className="label" htmlFor="ticker-search">
          Ticker
        </label>
        <div className="mt-1 flex items-center gap-2 border border-term-line bg-term-bg px-2 py-1.5 focus-within:border-fact/60">
          <input
            id="ticker-search"
            value={query}
            onChange={(e) => setQuery(e.target.value.toUpperCase())}
            placeholder="AAPL"
            maxLength={10}
            className="w-full bg-transparent font-mono text-sm uppercase text-term-bright placeholder:text-term-dim focus:outline-none"
          />
          <button type="submit" className="font-mono text-2xs uppercase tracking-wider text-fact hover:text-term-bright">
            run
          </button>
        </div>
      </form>

      <nav className="flex-1 overflow-y-auto">
        <SidebarSection title={`Watchlist (${tickers.length})`}>
          {tickers.length === 0 ? (
            <p className="px-4 py-2 font-mono text-2xs text-term-dim">
              Nothing saved yet. Star a company to keep it here.
            </p>
          ) : (
            <ul>
              {tickers.map((t) => (
                <li key={t}>
                  <button
                    type="button"
                    onClick={() => go(t)}
                    className={clsx(
                      "flex w-full items-center gap-2 px-4 py-1.5 text-left font-mono text-xs hover:bg-term-raised",
                      t === activeTicker ? "border-l-2 border-l-fact text-fact" : "text-term-text"
                    )}
                  >
                    {t}
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(t);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.stopPropagation();
                          toggle(t);
                        }
                      }}
                      className="ml-auto text-term-dim hover:text-down"
                      aria-label={`Remove ${t} from watchlist`}
                    >
                      ×
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SidebarSection>

        <SidebarSection title="Recent research">
          {history.length === 0 ? (
            <p className="px-4 py-2 font-mono text-2xs text-term-dim">No reports run yet.</p>
          ) : (
            <ul>
              {history.map((h) => (
                <li key={h.ticker}>
                  <button
                    type="button"
                    onClick={() => go(h.ticker)}
                    className={clsx(
                      "flex w-full flex-col items-start px-4 py-1.5 text-left hover:bg-term-raised",
                      h.ticker === activeTicker && "border-l-2 border-l-fact"
                    )}
                  >
                    <span className={clsx("font-mono text-xs", h.ticker === activeTicker ? "text-fact" : "text-term-text")}>
                      {h.ticker}
                    </span>
                    <span className="font-mono text-2xs text-term-dim">{relativeTime(h.viewedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SidebarSection>
      </nav>

      {activeTicker && (
        <div className="border-t border-term-line px-3 py-2">
          <button
            type="button"
            onClick={() => toggle(activeTicker)}
            className="w-full rounded-sm border border-term-line px-2 py-1.5 font-mono text-2xs uppercase tracking-wider text-term-dim hover:border-fact/50 hover:text-fact"
          >
            {has(activeTicker) ? "★ remove from watchlist" : "☆ add to watchlist"}
          </button>
        </div>
      )}

      <ThemeToggle />
    </aside>
  );
}

function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-term-line py-2">
      <p className="label px-4 pb-1">{title}</p>
      {children}
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const saved = (window.localStorage.getItem("rc:theme") as "dark" | "light" | null) ?? "dark";
    setTheme(saved);
    document.documentElement.dataset.theme = saved;
  }, []);

  const flip = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    window.localStorage.setItem("rc:theme", next);
  };

  return (
    <button
      type="button"
      onClick={flip}
      className="border-t border-term-line px-4 py-2 text-left font-mono text-2xs uppercase tracking-wider text-term-dim hover:text-term-text"
    >
      {theme === "dark" ? "◐ light mode" : "◑ dark mode"}
    </button>
  );
}
