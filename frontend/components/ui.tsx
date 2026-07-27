import Link from "next/link";
import type { ReactNode } from "react";

/* ---------- page scaffolding ---------- */

export function PageHeader({
  index,
  title,
  lede,
}: {
  index: string;
  title: string;
  lede: ReactNode;
}) {
  return (
    <header className="border-b border-rule pb-7 mb-9">
      <div className="font-mono text-[11px] tracking-[0.18em] text-ink-3 uppercase mb-3">
        {index}
      </div>
      <h1 className="font-display text-[2.6rem] leading-[1.05] tracking-[-0.01em] mb-3">
        {title}
      </h1>
      <p className="text-ink-2 max-w-[62ch] text-[15.5px]">{lede}</p>
    </header>
  );
}

export function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-11">
      <div className="flex items-baseline justify-between gap-4 mb-4">
        <h2 className="font-mono text-[11px] tracking-[0.16em] uppercase text-ink-3">{title}</h2>
        {hint && <span className="text-[12.5px] text-ink-3">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

export function Panel({
  children,
  className = "",
  tone = "card",
}: {
  children: ReactNode;
  className?: string;
  tone?: "card" | "flat";
}) {
  return (
    <div
      className={`border border-rule ${tone === "card" ? "bg-card" : "bg-transparent"} ${className}`}
    >
      {children}
    </div>
  );
}

export function PanelHead({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-2.5 border-b border-rule font-mono text-[11px] tracking-[0.12em] uppercase text-ink-3 flex items-center justify-between gap-3">
      {children}
    </div>
  );
}

/* ---------- data display ---------- */

export function Stat({
  label,
  value,
  unit,
  sub,
  tone = "ink",
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  tone?: "ink" | "sealed" | "exposed";
}) {
  const color =
    tone === "sealed" ? "text-sealed" : tone === "exposed" ? "text-exposed" : "text-ink";
  return (
    <div className="px-4 py-3.5">
      <div className="font-mono text-[10.5px] tracking-[0.13em] uppercase text-ink-3 mb-1.5">
        {label}
      </div>
      <div className={`font-mono tnum text-[1.45rem] leading-none ${color}`}>
        {value}
        {unit && <span className="text-[0.72em] text-ink-3 ml-1.5">{unit}</span>}
      </div>
      {sub && <div className="text-[12px] text-ink-3 mt-1.5 leading-snug">{sub}</div>}
    </div>
  );
}

export function StatRow({ children }: { children: ReactNode }) {
  return (
    <Panel>
      <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-y md:divide-y-0 divide-rule">
        {children}
      </div>
    </Panel>
  );
}

export function Field({
  k,
  children,
  mono = true,
}: {
  k: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-6 px-4 py-2.5 border-b border-rule last:border-0">
      <span className="text-[13px] text-ink-3 shrink-0">{k}</span>
      <span className={`text-[13px] text-right break-all ${mono ? "font-mono tnum" : ""}`}>
        {children}
      </span>
    </div>
  );
}

export function Badge({
  children,
  tone = "ink",
}: {
  children: ReactNode;
  tone?: "ink" | "sealed" | "exposed" | "warn" | "muted";
}) {
  const tones = {
    ink: "bg-ink text-paper border-ink",
    sealed: "bg-sealed-bg text-sealed border-sealed/25",
    exposed: "bg-exposed-bg text-exposed border-exposed/25",
    warn: "bg-warn-bg text-warn border-warn/25",
    muted: "bg-paper-2 text-ink-3 border-rule",
  };
  return (
    <span
      className={`inline-block border px-2 py-[3px] font-mono text-[10.5px] tracking-[0.1em] uppercase leading-none ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/** Encrypted values are never shown as numbers — this is the visual stand-in. */
export function Cipher({ width = 7 }: { width?: number }) {
  return (
    <span
      className="font-mono text-sealed/70 select-none"
      title="Encrypted — stored as a Nox handle"
    >
      {"▓".repeat(width)}
    </span>
  );
}

export function Callout({
  kind = "note",
  title,
  children,
}: {
  kind?: "note" | "warn" | "sealed";
  title?: string;
  children: ReactNode;
}) {
  const map = {
    note: "border-rule-2 bg-paper-2",
    warn: "border-warn/30 bg-warn-bg",
    sealed: "border-sealed/25 bg-sealed-bg",
  };
  return (
    <div className={`border-l-2 ${map[kind]} px-4 py-3 text-[13.5px] leading-relaxed`}>
      {title && <div className="font-medium mb-1">{title}</div>}
      <div className="text-ink-2">{children}</div>
    </div>
  );
}

/* ---------- controls ---------- */

export function Button({
  children,
  onClick,
  disabled,
  busy,
  variant = "primary",
  type = "button",
  full,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  variant?: "primary" | "ghost" | "danger";
  type?: "button" | "submit";
  full?: boolean;
}) {
  const base =
    "font-mono text-[12px] tracking-[0.09em] uppercase px-4 py-2.5 border transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
  const variants = {
    primary: "bg-ink text-paper border-ink hover:bg-ink-2 hover:border-ink-2",
    ghost: "bg-transparent text-ink border-rule-2 hover:bg-paper-2",
    danger: "bg-transparent text-exposed border-exposed/40 hover:bg-exposed-bg",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      className={`${base} ${variants[variant]} ${full ? "w-full" : ""}`}
    >
      {busy ? "working…" : children}
    </button>
  );
}

export function Input({
  value,
  onChange,
  placeholder,
  suffix,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  suffix?: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-stretch border border-rule-2 bg-card">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        inputMode="decimal"
        className="flex-1 min-w-0 bg-transparent px-3 py-2.5 text-[14px] tnum outline-none disabled:opacity-50"
      />
      {suffix && (
        <span className="flex items-center px-3 border-l border-rule text-[12px] font-mono text-ink-3">
          {suffix}
        </span>
      )}
    </div>
  );
}

/* ---------- links ---------- */

export function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline decoration-rule-2 underline-offset-[3px] hover:decoration-ink"
    >
      {children}
    </a>
  );
}

export function NextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="underline decoration-rule-2 underline-offset-[3px] hover:decoration-ink"
    >
      {children}
    </Link>
  );
}

/** Bottom-of-page pointer to the next step in the reading order. */
export function NextUp({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="group flex items-center justify-between border-t border-rule pt-5 mt-14 hover:border-ink transition-colors"
    >
      <span className="font-mono text-[11px] tracking-[0.14em] uppercase text-ink-3">Next</span>
      <span className="font-display text-[1.35rem] group-hover:underline decoration-rule-2 underline-offset-4">
        {label} →
      </span>
    </Link>
  );
}
