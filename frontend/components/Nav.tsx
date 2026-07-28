"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useWallet } from "@/lib/wallet";
import { short } from "@/lib/format";

export const PAGES = [
  { n: "01", href: "/", label: "Overview", group: "Understand" },
  { n: "02", href: "/how-it-works", label: "How it works", group: "Understand" },
  { n: "03", href: "/privacy", label: "Privacy model", group: "Understand" },
  { n: "04", href: "/architecture", label: "Architecture", group: "Understand" },
  { n: "05", href: "/start", label: "Get started", group: "Use" },
  { n: "06", href: "/trade", label: "Place an order", group: "Use" },
  { n: "07", href: "/balances", label: "Your balances", group: "Use" },
  { n: "08", href: "/epochs", label: "Epochs", group: "Observe" },
  { n: "09", href: "/settle", label: "Settlement desk", group: "Observe" },
  { n: "10", href: "/proof", label: "Proof of no leakage", group: "Verify" },
  { n: "11", href: "/analytics", label: "Execution analytics", group: "Verify" },
  { n: "12", href: "/auditor", label: "Compliance", group: "Verify" },
  { n: "13", href: "/security", label: "Security", group: "Reference" },
  { n: "14", href: "/contracts", label: "Contracts", group: "Reference" },
  { n: "15", href: "/faq", label: "FAQ", group: "Reference" },
];

const GROUPS = ["Understand", "Use", "Observe", "Verify", "Reference"] as const;

export function Nav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* mobile bar */}
      <div className="lg:hidden sticky top-0 z-30 flex items-center justify-between border-b border-rule bg-paper px-4 py-3">
        <Link href="/" className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/mark.png" alt="" aria-hidden className="h-[26px] w-[26px] object-contain" />
          <span className="font-display text-[1.25rem] leading-none">Kairos Layer</span>
        </Link>
        <button
          onClick={() => setOpen((o) => !o)}
          className="font-mono text-[11px] uppercase tracking-[0.12em] border border-rule-2 px-3 py-1.5"
        >
          {open ? "Close" : "Menu"}
        </button>
      </div>

      <aside
        className={`${
          open ? "block" : "hidden"
        } lg:block lg:fixed lg:top-0 lg:left-0 lg:h-screen lg:w-[264px] border-r border-rule bg-paper-2/40 shrink-0 overflow-y-auto`}
      >
        <div className="px-6 py-7 hidden lg:block">
          <Link href="/" className="block">
            {/* Stacked, not inline: the 264px rail is too narrow to sit the mark
                beside the wordmark without wrapping the subtitle. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/mark.png" alt="" aria-hidden className="h-14 w-14 object-contain -ml-1" />
            <div className="font-display text-[1.55rem] leading-none mt-3">Kairos Layer</div>
            <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-ink-3 mt-2">
              Confidential dark pool
            </div>
          </Link>
        </div>

        <nav className="px-3 pb-6 lg:pb-10">
          {GROUPS.map((g) => (
            <div key={g} className="mb-5">
              <div className="px-3 mb-1.5 font-mono text-[10px] tracking-[0.18em] uppercase text-ink-3/70">
                {g}
              </div>
              {PAGES.filter((p) => p.group === g).map((p) => {
                const active =
                  pathname === p.href || (p.href !== "/" && pathname.startsWith(p.href));
                return (
                  <Link
                    key={p.href}
                    href={p.href}
                    onClick={() => setOpen(false)}
                    className={`flex items-baseline gap-2.5 px-3 py-[7px] text-[13.5px] transition-colors ${
                      active
                        ? "bg-ink text-paper"
                        : "text-ink-2 hover:text-ink hover:bg-paper-2"
                    }`}
                  >
                    <span
                      className={`font-mono text-[10px] tnum ${
                        active ? "text-paper/60" : "text-ink-3/70"
                      }`}
                    >
                      {p.n}
                    </span>
                    {p.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="px-6 pb-8 hidden lg:block">
          <ConnectInline />
        </div>
      </aside>
    </>
  );
}

export function ConnectInline() {
  const { address, connect, connecting, wrongChain, switchChain, hasWallet } = useWallet();

  if (address && wrongChain) {
    return (
      <button
        onClick={switchChain}
        className="w-full border border-exposed/40 bg-exposed-bg text-exposed font-mono text-[11px] uppercase tracking-[0.1em] px-3 py-2"
      >
        Switch to Sepolia
      </button>
    );
  }
  if (address) {
    return (
      <div className="border border-rule bg-card px-3 py-2">
        <div className="font-mono text-[9.5px] tracking-[0.14em] uppercase text-ink-3">
          Connected
        </div>
        <div className="font-mono text-[12px] mt-0.5">{short(address, 5)}</div>
      </div>
    );
  }
  return (
    <button
      onClick={connect}
      disabled={connecting}
      className="w-full bg-ink text-paper font-mono text-[11px] uppercase tracking-[0.1em] px-3 py-2.5 hover:bg-ink-2 disabled:opacity-50"
    >
      {connecting ? "Connecting…" : hasWallet ? "Connect wallet" : "Install MetaMask"}
    </button>
  );
}
