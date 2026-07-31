"use client";

import clsx from "clsx";
import { createContext, useContext, useState, type ReactNode } from "react";
import type { Evidence, ProviderAttempt } from "@/lib/types";
import { relativeTime } from "@/lib/format";

// --------------------------------------------------------------------------
// Evidence context: powers the citation chips
// --------------------------------------------------------------------------

interface EvidenceCtx {
  items: Evidence[];
  active: string | null;
  focus: (id: string | null) => void;
}
const EvidenceContext = createContext<EvidenceCtx>({ items: [], active: null, focus: () => {} });

export function EvidenceProvider({ items, children }: { items: Evidence[]; children: ReactNode }) {
  const [active, setActive] = useState<string | null>(null);
  return (
    <EvidenceContext.Provider value={{ items, active, focus: setActive }}>{children}</EvidenceContext.Provider>
  );
}

export const useEvidence = () => useContext(EvidenceContext);

/**
 * A citation chip. Clicking scrolls the matching evidence row into view and
 * highlights it — the citation is a live link into the source set, not a
 * decorative superscript. This is the difference between "shows citations" and
 * "citations you can actually check".
 */
export function Cite({ ids }: { ids: string[] }) {
  const { items, focus } = useEvidence();
  const valid = ids.filter((id) => items.some((i) => i.id === id));
  if (valid.length === 0) return null;

  return (
    <>
      {valid.map((id) => {
        const item = items.find((i) => i.id === id);
        return (
          <button
            key={id}
            type="button"
            className="cite"
            title={item ? `${item.provider} — ${item.text.slice(0, 180)}` : id}
            onClick={() => {
              focus(id);
              document.getElementById(`evidence-${id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
            }}
          >
            {id}
          </button>
        );
      })}
    </>
  );
}

/** A model-written claim with its citations, plus an unsupported marker. */
export function ClaimLine({ text, citations }: { text: string; citations?: string[] }) {
  const looksFactual = /\d|[$€£¥]|%/.test(text);
  const unsupported = looksFactual && (!citations || citations.length === 0);

  return (
    <li className={clsx("prose-ai flex gap-2 py-1", unsupported && "unsupported")}>
      <span aria-hidden className="mt-[0.45em] h-1 w-1 shrink-0 rounded-full bg-infer/70" />
      <span>
        {text}
        <Cite ids={citations ?? []} />
        {unsupported && (
          <span className="ml-1.5 font-mono text-2xs uppercase tracking-wider text-down" title="No retrieved source backs this figure">
            unsupported
          </span>
        )}
      </span>
    </li>
  );
}

/** The evidence drawer. Every id the report can cite, in one scrollable list. */
export function EvidenceList() {
  const { items, active } = useEvidence();
  if (items.length === 0) return null;

  return (
    <ol className="divide-y divide-term-line">
      {items.map((item) => (
        <li
          key={item.id}
          id={`evidence-${item.id}`}
          data-active={active === item.id}
          className="evidence-row px-4 py-2.5 transition-colors"
        >
          <div className="mb-1 flex items-baseline gap-2">
            <span className="font-mono text-2xs font-semibold text-infer">[{item.id}]</span>
            <span className="label">{item.provider}</span>
            <span className="label ml-auto">{relativeTime(item.asOf)}</span>
          </div>
          <p className="font-mono text-xs leading-relaxed text-term-text">{item.text}</p>
          {item.url && (
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block font-mono text-2xs text-fact underline decoration-fact/40 hover:decoration-fact"
            >
              open source ↗
            </a>
          )}
        </li>
      ))}
    </ol>
  );
}

// --------------------------------------------------------------------------
// Layout primitives
// --------------------------------------------------------------------------

export function Panel({
  title,
  subtitle,
  action,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx("panel animate-fade-up", className)}>
      <header className="panel-header">
        <div className="min-w-0">
          <h2 className="label text-term-text">{title}</h2>
          {subtitle && <p className="mt-0.5 truncate font-mono text-2xs text-term-dim">{subtitle}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

/** Labelled figure. `source` marks whether it was retrieved or computed. */
export function Metric({
  label,
  value,
  hint,
  tone = "fact",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "fact" | "neutral" | "up" | "down";
}) {
  const toneClass = {
    fact: "fact",
    neutral: "datum",
    up: "font-mono tabular-nums text-up",
    down: "font-mono tabular-nums text-down",
  }[tone];

  return (
    <div className="border-b border-r border-term-line px-3 py-2.5 last:border-r-0">
      <div className="label">{label}</div>
      <div className={clsx("mt-1 text-sm", toneClass)}>{value}</div>
      {hint && <div className="mt-0.5 font-mono text-2xs text-term-dim">{hint}</div>}
    </div>
  );
}

export function Skeleton({ rows = 3, label }: { rows?: number; label?: string }) {
  return (
    <div className="space-y-2 p-4" role="status" aria-live="polite">
      {label && <p className="label animate-pulse-line">{label}</p>}
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-3 animate-pulse-line rounded bg-term-raised"
          style={{ width: `${100 - i * 12}%`, animationDelay: `${i * 120}ms` }}
        />
      ))}
    </div>
  );
}

export function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="px-4 py-8 text-center">
      <p className="font-mono text-sm text-term-bright">{title}</p>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-term-dim">{detail}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/**
 * Failure states name the provider and the reason. "Something went wrong" is
 * useless to an analyst deciding whether to trust the rest of the page.
 */
export function SectionError({ section, message }: { section: string; message: string }) {
  return (
    <div className="border-l-2 border-l-down bg-down/5 px-4 py-3">
      <p className="label text-down">{section} unavailable</p>
      <p className="mt-1 font-mono text-xs leading-relaxed text-term-text">{message}</p>
    </div>
  );
}

/** Provider status rail. Makes silent failover visible. */
export function StatusRail({ attempts }: { attempts: ProviderAttempt[] }) {
  const [open, setOpen] = useState(false);
  const failures = attempts.filter((a) => !a.ok && a.error !== "not configured");

  return (
    <div className="border-t border-term-line bg-term-panel">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-term-raised"
      >
        <span className={clsx("h-1.5 w-1.5 rounded-full", failures.length ? "bg-fact" : "bg-up")} />
        <span className="label">
          {attempts.filter((a) => a.ok).length} of {attempts.length} provider calls succeeded
        </span>
        <span className="label ml-auto">{open ? "hide" : "detail"}</span>
      </button>
      {open && (
        <ul className="max-h-48 overflow-y-auto border-t border-term-line">
          {attempts.map((a, i) => (
            <li key={`${a.provider}-${i}`} className="flex items-baseline gap-2 px-4 py-1.5 font-mono text-2xs">
              <span className={a.ok ? "text-up" : "text-term-dim"}>{a.ok ? "ok " : "err"}</span>
              <span className="text-term-text">{a.provider}</span>
              <span className="text-term-dim">{a.ms}ms</span>
              {a.error && <span className="truncate text-down">{a.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "up" | "down" | "fact" | "infer" }) {
  const tones = {
    neutral: "border-term-line text-term-dim",
    up: "border-up/40 bg-up/10 text-up",
    down: "border-down/40 bg-down/10 text-down",
    fact: "border-fact/40 bg-fact/10 text-fact",
    infer: "border-infer/40 bg-infer/10 text-infer",
  }[tone];
  return (
    <span className={clsx("inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-2xs uppercase tracking-wider", tones)}>
      {children}
    </span>
  );
}
