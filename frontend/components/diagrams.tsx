import type { ReactNode } from "react";

/* ------------------------------------------------------------------ *
 * Visual explainers. All hand-drawn SVG — no chart library, no icons
 * font. Colour is semantic: sealed = encrypted, exposed = public.
 * ------------------------------------------------------------------ */

const SEALED = "var(--sealed)";
const EXPOSED = "var(--exposed)";
const INK = "var(--ink)";
const INK3 = "var(--ink-3)";
const RULE = "var(--rule-2)";

export function Figure({
  caption,
  children,
  wide,
}: {
  caption: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <figure className={wide ? "-mx-2" : ""}>
      <div className="border border-rule bg-card p-4 overflow-x-auto">{children}</div>
      <figcaption className="text-[12.5px] text-ink-3 mt-2 leading-snug">{caption}</figcaption>
    </figure>
  );
}

/** The six-step order lifecycle, left to right. */
export function LifecycleStrip() {
  const steps = [
    { t: "Encrypt", d: "in your browser", tone: SEALED },
    { t: "Submit", d: "handle + proof", tone: SEALED },
    { t: "Batch", d: "epoch collects", tone: SEALED },
    { t: "Reveal", d: "totals only", tone: EXPOSED },
    { t: "Net + swap", d: "residual only", tone: EXPOSED },
    { t: "Claim", d: "encrypted payout", tone: SEALED },
  ];
  return (
    <svg viewBox="0 0 860 132" className="w-full min-w-[700px]" role="img">
      <title>Order lifecycle from encryption to claim</title>
      {steps.map((s, i) => {
        const x = 8 + i * 142;
        return (
          <g key={s.t}>
            <rect
              x={x}
              y={30}
              width={122}
              height={54}
              fill="none"
              stroke={s.tone}
              strokeWidth={1.2}
            />
            <text x={x + 12} y={52} fontSize="13" fill={INK} fontFamily="var(--font-plex-sans)">
              {s.t}
            </text>
            <text x={x + 12} y={70} fontSize="10.5" fill={INK3} fontFamily="var(--font-plex-mono)">
              {s.d}
            </text>
            <text
              x={x + 108}
              y={24}
              fontSize="9.5"
              fill={INK3}
              textAnchor="end"
              fontFamily="var(--font-plex-mono)"
            >
              {String(i + 1).padStart(2, "0")}
            </text>
            {i < steps.length - 1 && (
              <line
                x1={x + 122}
                y1={57}
                x2={x + 142}
                y2={57}
                stroke={RULE}
                strokeWidth={1.2}
                markerEnd="url(#arw)"
              />
            )}
          </g>
        );
      })}
      <defs>
        <marker id="arw" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <path d="M0,0 L7,3.5 L0,7 z" fill={RULE} />
        </marker>
      </defs>
      <text x={8} y={112} fontSize="10.5" fill={SEALED} fontFamily="var(--font-plex-mono)">
        ■ amounts encrypted
      </text>
      <text x={168} y={112} fontSize="10.5" fill={EXPOSED} fontFamily="var(--font-plex-mono)">
        ■ aggregate visible on-chain
      </text>
    </svg>
  );
}

/** Bar showing how much volume was internally crossed vs sent to Uniswap. */
export function NettingBar({
  matched,
  residual,
  matchedLabel,
  residualLabel,
}: {
  matched: number;
  residual: number;
  matchedLabel: string;
  residualLabel: string;
}) {
  const total = matched + residual || 1;
  const mPct = (matched / total) * 100;
  return (
    <div>
      <div className="flex h-11 border border-rule">
        <div
          className="bg-sealed-bg border-r border-sealed/30 flex items-center justify-center"
          style={{ width: `${mPct}%` }}
        >
          {mPct > 14 && (
            <span className="font-mono text-[11px] text-sealed">{mPct.toFixed(1)}%</span>
          )}
        </div>
        <div className="bg-exposed-bg flex items-center justify-center" style={{ flex: 1 }}>
          {100 - mPct > 14 && (
            <span className="font-mono text-[11px] text-exposed">{(100 - mPct).toFixed(1)}%</span>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 mt-2.5">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-sealed">
            Crossed internally
          </div>
          <div className="font-mono tnum text-[13px] mt-0.5">{matchedLabel}</div>
          <div className="text-[11.5px] text-ink-3 leading-snug mt-0.5">
            Never appeared on the public chain.
          </div>
        </div>
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-exposed">
            Residual → Uniswap
          </div>
          <div className="font-mono tnum text-[13px] mt-0.5">{residualLabel}</div>
          <div className="text-[11.5px] text-ink-3 leading-snug mt-0.5">
            One aggregate swap; no individual size attached.
          </div>
        </div>
      </div>
    </div>
  );
}

/** Side-by-side: what a normal DEX leaks vs what Kairos leaks. */
export function ExposureCompare() {
  const rows = [
    ["Who traded", "public", "public"],
    ["Trade direction", "public", "public"],
    ["Your order size", "public", "hidden"],
    ["Your balance", "public", "hidden"],
    ["Your payout", "public", "hidden"],
    ["Batch total", "public", "public"],
    ["Matched volume", "public", "never on-chain"],
  ];
  return (
    <div className="border border-rule">
      <div className="grid grid-cols-[1fr_auto_auto] font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3 border-b border-rule">
        <div className="px-3 py-2">Datum</div>
        <div className="px-3 py-2 w-[130px] border-l border-rule">Ordinary DEX</div>
        <div className="px-3 py-2 w-[130px] border-l border-rule">Kairos Layer</div>
      </div>
      {rows.map(([k, a, b]) => (
        <div
          key={k}
          className="grid grid-cols-[1fr_auto_auto] border-b border-rule last:border-0 text-[13px]"
        >
          <div className="px-3 py-2">{k}</div>
          <div className="px-3 py-2 w-[130px] border-l border-rule font-mono text-[11.5px] text-exposed">
            {a}
          </div>
          <div
            className={`px-3 py-2 w-[130px] border-l border-rule font-mono text-[11.5px] ${
              b === "public" ? "text-exposed" : "text-sealed"
            }`}
          >
            {b}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Epoch state machine, including every escape hatch. */
export function StateMachine() {
  const box = (x: number, y: number, w: number, label: string, tone = INK) => (
    <g key={label + x + y}>
      <rect x={x} y={y} width={w} height={30} fill="none" stroke={tone} strokeWidth={1.2} />
      <text
        x={x + w / 2}
        y={y + 19.5}
        fontSize="11.5"
        fill={tone}
        textAnchor="middle"
        fontFamily="var(--font-plex-mono)"
      >
        {label}
      </text>
    </g>
  );
  const arrow = (x1: number, y1: number, x2: number, y2: number, label?: string, dash = false) => (
    <g key={`${x1}-${y1}-${x2}-${y2}-${label}`}>
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={dash ? EXPOSED : RULE}
        strokeWidth={1.2}
        strokeDasharray={dash ? "4 3" : undefined}
        markerEnd={dash ? "url(#arw2r)" : "url(#arw2)"}
      />
      {label && (
        <text
          x={(x1 + x2) / 2}
          y={y1 === y2 ? y1 - 6 : (y1 + y2) / 2 - 4}
          fontSize="9.5"
          fill={dash ? EXPOSED : INK3}
          textAnchor="middle"
          fontFamily="var(--font-plex-mono)"
        >
          {label}
        </text>
      )}
    </g>
  );
  return (
    <svg viewBox="0 0 860 240" className="w-full min-w-[720px]" role="img">
      <title>Epoch state machine with escape hatches</title>
      <defs>
        <marker id="arw2" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <path d="M0,0 L7,3.5 L0,7 z" fill={RULE} />
        </marker>
        <marker id="arw2r" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <path d="M0,0 L7,3.5 L0,7 z" fill={EXPOSED} />
        </marker>
      </defs>

      {box(8, 40, 96, "Open")}
      {arrow(104, 55, 150, 55, "seal")}
      {box(150, 40, 96, "Sealed")}
      {arrow(246, 55, 292, 55, "reveal")}
      {box(292, 40, 108, "Revealed")}
      {arrow(400, 55, 446, 55, "net")}
      {box(446, 40, 138, "UnwrapPending")}
      {arrow(584, 55, 630, 55, "swap")}
      {box(630, 40, 122, "Distributable", SEALED)}
      {arrow(691, 70, 691, 104, "claim")}
      {box(630, 104, 122, "paid out", SEALED)}

      {/* escape hatches */}
      {box(292, 176, 122, "Cancelled", EXPOSED)}
      {arrow(56, 70, 300, 176, "timeout", true)}
      {arrow(198, 70, 330, 176, "timeout", true)}
      {arrow(346, 70, 353, 176, "", true)}
      {arrow(500, 70, 400, 176, "recover", true)}
      {arrow(560, 70, 660, 104, "abandon", true)}
      <text x={292} y={222} fontSize="10.5" fill={EXPOSED} fontFamily="var(--font-plex-mono)">
        every dashed path refunds deposits in full
      </text>
    </svg>
  );
}

/** Layer map: which parts are ours, which are external and untouched. */
export function StackMap() {
  const layer = (
    y: number,
    label: string,
    sub: string,
    tone: string,
    note: string,
  ) => (
    <g key={label}>
      <rect x={8} y={y} width={520} height={46} fill="none" stroke={tone} strokeWidth={1.2} />
      <text x={22} y={y + 21} fontSize="13" fill={INK} fontFamily="var(--font-plex-sans)">
        {label}
      </text>
      <text x={22} y={y + 37} fontSize="10.5" fill={INK3} fontFamily="var(--font-plex-mono)">
        {sub}
      </text>
      <text x={546} y={y + 28} fontSize="10.5" fill={tone} fontFamily="var(--font-plex-mono)">
        {note}
      </text>
    </g>
  );
  return (
    <svg viewBox="0 0 780 268" className="w-full min-w-[680px]" role="img">
      <title>System layers</title>
      {layer(8, "Browser", "encryptInput() · decrypt() — plaintext never leaves", SEALED, "user side")}
      {layer(64, "KairosPool.sol", "epochs · netting · escrow · pull claims", INK, "ours")}
      {layer(120, "iExec Nox", "NoxCompute + TEE runner + handle gateway + KMS", SEALED, "unmodified")}
      {layer(176, "Uniswap V3", "canonical pool — receives the residual only", EXPOSED, "unmodified")}
      <line x1={268} y1={54} x2={268} y2={64} stroke={RULE} strokeWidth={1.2} />
      <line x1={268} y1={110} x2={268} y2={120} stroke={RULE} strokeWidth={1.2} />
      <line x1={268} y1={166} x2={268} y2={176} stroke={RULE} strokeWidth={1.2} />
      <text x={8} y={246} fontSize="10.5" fill={INK3} fontFamily="var(--font-plex-mono)">
        We add one contract. Nothing beneath it is forked, wrapped or modified.
      </text>
    </svg>
  );
}

/** Small numbered step used in walkthroughs. */
export function Step({
  n,
  title,
  children,
  tone = "ink",
}: {
  n: number | string;
  title: string;
  children: ReactNode;
  tone?: "ink" | "sealed" | "exposed";
}) {
  const color =
    tone === "sealed" ? "text-sealed" : tone === "exposed" ? "text-exposed" : "text-ink";
  return (
    <div className="flex gap-4 border-b border-rule py-4 last:border-0">
      <div className={`font-mono text-[12px] tnum shrink-0 w-6 ${color}`}>
        {typeof n === "number" ? String(n).padStart(2, "0") : n}
      </div>
      <div className="min-w-0">
        <div className="font-medium text-[14.5px] mb-1">{title}</div>
        <div className="text-[13.5px] text-ink-2 leading-relaxed">{children}</div>
      </div>
    </div>
  );
}
