"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Decorative seal in the right-hand gutter. Line art on transparent ground,
 * held at a low opacity so it reads as watermarked into the paper rather than
 * as an illustration competing with the page. Only shown from xl up, where
 * there is genuinely empty space beside the 900px measure.
 */
export function DragonMark() {
  return (
    <div
      aria-hidden
      className="pointer-events-none select-none fixed inset-y-0 right-0 z-0 hidden xl:flex items-center justify-end overflow-hidden"
      style={{ width: "min(46vw, 640px)" }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/dragon.png"
        alt=""
        className="h-[86vh] w-auto max-w-none opacity-[0.07] translate-x-[14%]"
        style={{
          // Fade the mark out towards the text so it never crowds the measure.
          maskImage: "linear-gradient(to right, transparent, #000 55%)",
          WebkitMaskImage: "linear-gradient(to right, transparent, #000 55%)",
        }}
      />
    </div>
  );
}

/**
 * Persistent call to action. Hidden on /start, where it would point at the page
 * you are already reading, and on mobile, where the top-right corner belongs to
 * the Menu button and the drawer already lists "Get started" as item 05.
 */
export function GetStartedButton() {
  const pathname = usePathname();
  if (pathname === "/start") return null;

  return (
    <Link
      href="/start"
      className="hidden lg:inline-flex fixed top-6 right-8 z-50 group items-center gap-2
                 bg-ink text-paper font-mono text-[11px] uppercase tracking-[0.14em]
                 px-4 py-2.5 border border-ink shadow-[0_1px_12px_rgba(22,21,15,0.13)]
                 transition-colors hover:bg-paper hover:text-ink"
    >
      Get started
      <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
        →
      </span>
    </Link>
  );
}
