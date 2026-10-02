// Illustrations for the How it works page. Each one makes a single point with real numbers:
// the contract's parameters (lib/math.ts), figures asserted in contracts/test, sourced case facts
// (lib/cases.ts) and a real seeded profile row. Static SVG from the design tokens.

const C = {
  accent: "var(--color-accent)",
  lavender: "var(--color-lavender)",
  ink: "var(--color-ink)",
  muted: "var(--color-muted)",
  faint: "var(--color-faint)",
  line: "var(--color-line)",
  lineStrong: "var(--color-line-strong)",
  card: "var(--color-card)",
  alt: "var(--color-card-alt)",
  ground: "var(--color-ground)",
  off: "var(--color-dot-off)",
};

type Anchor = "start" | "middle" | "end";

/** Small uppercase mono label. */
function Label({ x, y, children, fill = C.muted, size = 11, anchor = "start" }: { x: number; y: number; children: React.ReactNode; fill?: string; size?: number; anchor?: Anchor }) {
  return (
    <text x={x} y={y} fill={fill} fontSize={size} textAnchor={anchor} className="font-mono uppercase" letterSpacing="0.08em">
      {children}
    </text>
  );
}

/** Big dot-matrix number. */
function Big({ x, y, children, fill = C.ink, size = 28, anchor = "start" }: { x: number; y: number; children: React.ReactNode; fill?: string; size?: number; anchor?: Anchor }) {
  return (
    <text x={x} y={y} fill={fill} fontSize={size} textAnchor={anchor} fontWeight={900} className="font-dot">
      {children}
    </text>
  );
}

/** Plain sentence-case text. */
function Note({ x, y, children, fill = C.muted, size = 12, anchor = "start" }: { x: number; y: number; children: React.ReactNode; fill?: string; size?: number; anchor?: Anchor }) {
  return (
    <text x={x} y={y} fill={fill} fontSize={size} textAnchor={anchor} className="font-sans">
      {children}
    </text>
  );
}

// Dot-matrix laurel (brand geometry).
const STEM: [number, number][] = [[28, 57], [21, 53], [16, 47], [13, 40], [12, 32], [13, 24], [16, 17]];
const LEAF: [number, number][] = [[21, 59], [13, 55], [8, 49], [5, 41], [5, 32], [6, 23], [10, 15]];
function Laurel({ x, y, size, lit = 7 }: { x: number; y: number; size: number; lit?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${size / 64})`}>
      {STEM.map(([sx, sy], i) => {
        const [lx, ly] = LEAF[i];
        const fill = i < lit ? C.accent : C.off;
        return (
          <g key={i} fill={fill}>
            <circle cx={sx} cy={sy} r={2.4} />
            <circle cx={lx} cy={ly} r={3} />
            <circle cx={64 - sx} cy={sy} r={2.4} />
            <circle cx={64 - lx} cy={ly} r={3} />
          </g>
        );
      })}
    </g>
  );
}

/** A "TODAY" / "KLEOS" panel header. */
function PanelTag({ x, kleos }: { x: number; kleos?: boolean }) {
  return <Label x={x} y={18} fill={kleos ? C.accent : C.faint} size={10}>{kleos ? "Kleos" : "Today"}</Label>;
}

// ─── The thesis: same money, different weight ────────────────────────────────

/**
 * Two traders put in the same $100. In the money price they count the same; in the reputation
 * price the proven one counts 3× (R = 16 → M = 3). The money they get back is identical either way.
 */
export function SameBetDifferentWeight() {
  const rows = [
    { who: "Newcomer", r: "R 0 · M 1×", lit: 0, money: 100, weight: 100 },
    { who: "Sharp", r: "R 16 · M 3×", lit: 5, money: 100, weight: 300 },
  ];
  const X0 = 200, X1 = 420, scale = 0.45; // px per $, the same in both columns
  return (
    <svg viewBox="0 0 640 286" className="h-auto w-full" role="img" aria-label="Two traders each bet 100 dollars. Both count 100 in the money price; in the reputation price the newcomer counts 100 and the sharp counts 300. The newcomer gets the same payout per dollar and earns reputation for calls they get right; the sharp gets a 3 times voice in the reputation price and a bigger bonus share.">
      <Label x={X0} y={24} fill={C.lavender}>Money price weight</Label>
      <Label x={X1} y={24} fill={C.accent}>Reputation price weight</Label>
      {rows.map((row, i) => {
        const y = 52 + i * 80;
        return (
          <g key={row.who}>
            <Laurel x={14} y={y - 6} size={52} lit={row.lit} />
            <Note x={74} y={y + 16} fill={C.ink} size={15}>{row.who}</Note>
            <Label x={74} y={y + 34} fill={C.faint} size={10}>{row.r}</Label>
            <rect x={X0} y={y + 4} width={row.money * scale} height={26} rx={6} fill={C.lavender} />
            <Label x={X0 + row.money * scale + 8} y={y + 22} fill={C.ink} size={12}>${row.money}</Label>
            <rect x={X1} y={y + 4} width={row.weight * scale} height={26} rx={6} fill={C.accent} />
            <Label x={X1 + row.weight * scale + 8} y={y + 22} fill={C.ink} size={12}>${row.weight}</Label>
          </g>
        );
      })}
      <line x1={14} x2={626} y1={214} y2={214} stroke={C.line} />
      <Label x={14} y={240} fill={C.muted} size={10}>Newcomer gets</Label>
      <Note x={130} y={240} fill={C.ink} size={12}>Same payout per dollar as anyone from bet one, plus reputation for every right call.</Note>
      <Label x={14} y={268} fill={C.accent} size={10}>Sharp gets</Label>
      <Note x={130} y={268} fill={C.ink} size={12}>A 3× voice in the reputation price everyone sees, and a bigger share of the bonus.</Note>
    </svg>
  );
}

// ─── Why Kleos: today vs Kleos, one point per failure ─────────────────────────

/** Two-panel comparison for each failure on the Why Kleos cards. Facts from lib/cases.ts. */
export function FailureComic({ kind }: { kind: "capture" | "conflict" | "distortion" | "insider" }) {
  const frame = (
    <>
      <line x1={240} x2={240} y1={6} y2={164} stroke={C.lineStrong} strokeDasharray="2 5" />
      <PanelTag x={8} />
      <PanelTag x={252} kleos />
    </>
  );
  const common = { viewBox: "0 0 480 170", className: "h-auto w-full", role: "img" as const };

  if (kind === "capture") {
    // Today: one wallet holds about a quarter of the dispute vote. Kleos: five seats, one vote each, earned.
    return (
      <svg {...common} aria-label="Today one token holder casts about a quarter of the votes. In Kleos five jurors each hold one vote, earned through reputation.">
        {frame}
        <circle cx={70} cy={88} r={50} fill={C.lineStrong} />
        <path d="M70 88 L70 38 A50 50 0 0 1 120 88 Z" fill={C.lavender} />
        <Big x={146} y={84} size={26} fill={C.lavender}>~25%</Big>
        <Note x={146} y={104} size={11}>of the vote,</Note>
        <Note x={146} y={118} size={11}>one whale</Note>
        <Note x={8} y={160} size={11} fill={C.faint}>Votes are bought with tokens.</Note>
        {[0, 1, 2, 3, 4].map((i) => (
          <Laurel key={i} x={258 + i * 44} y={50} size={40} lit={7} />
        ))}
        <Label x={356} y={112} fill={C.muted} size={10} anchor="middle">5 seats · 1 vote each</Label>
        <Note x={252} y={160} size={11} fill={C.ink}>Seats are earned with a track record.</Note>
      </svg>
    );
  }
  if (kind === "conflict") {
    // Today: a voter holding YES votes on YES. Kleos: holding a position means you can't sit.
    const judge = (x: number, crossed: boolean) => (
      <g>
        <circle cx={x} cy={78} r={22} fill={C.alt} stroke={crossed ? C.faint : C.lineStrong} strokeWidth={2} />
        <rect x={x + 10} y={50} width={46} height={22} rx={5} fill={C.lavender} />
        <Label x={x + 33} y={65} fill={C.ground} size={10} anchor="middle">$ YES</Label>
        {crossed && <path d={`M${x - 18} ${60} L${x + 18} ${96}`} stroke={C.accent} strokeWidth={3} strokeLinecap="round" />}
      </g>
    );
    return (
      <svg {...common} aria-label="Today a voter holding a YES position can vote YES. In Kleos anyone with a position can't sit on the jury.">
        {frame}
        {judge(60, false)}
        <path d="M100 116 h40" stroke={C.faint} strokeWidth={2} />
        <rect x={146} y={104} width={64} height={24} rx={6} fill="none" stroke={C.lavender} />
        <Label x={178} y={120} fill={C.lavender} size={10} anchor="middle">votes YES</Label>
        <Note x={8} y={160} size={11} fill={C.faint}>~1 in 5 disputes had judges with a stake.</Note>
        {judge(300, true)}
        <path d="M342 92 h28" stroke={C.faint} strokeWidth={2} />
        <circle cx={398} cy={92} r={22} fill={C.alt} stroke={C.accent} strokeWidth={2} />
        <Label x={398} y={130} fill={C.accent} size={10} anchor="middle">no stake</Label>
        <Note x={252} y={160} size={11} fill={C.ink}>A position means you can&apos;t judge.</Note>
      </svg>
    );
  }
  if (kind === "distortion") {
    // Today: one money-only price that a whale can push. Kleos: the reputation price sits beside it.
    const meter = (x: number, y: number, v: number, color: string, label: string) => (
      <g>
        <Label x={x} y={y - 6} fill={color} size={10}>{label}</Label>
        <rect x={x} y={y} width={200} height={14} rx={7} fill={C.alt} />
        <rect x={x} y={y} width={200 * v} height={14} rx={7} fill={color} />
        <line x1={x + 100} x2={x + 100} y1={y - 3} y2={y + 17} stroke={C.lineStrong} />
        <Label x={x + 200} y={y - 6} fill={C.ink} size={11} anchor="end">{Math.round(v * 100)}% yes</Label>
      </g>
    );
    return (
      <svg {...common} aria-label="Today a whale moves the only price. In Kleos the same whale moves the money price to 44 percent while the reputation price stays at 71 percent.">
        {frame}
        {meter(8, 64, 0.44, C.lavender, "the only price")}
        <Note x={8} y={112} size={11}>A $2,000 whale vs 20 sharps</Note>
        <Note x={8} y={160} size={11} fill={C.faint}>Whoever has the most money sets the odds.</Note>
        {meter(252, 52, 0.44, C.lavender, "money price")}
        {meter(252, 100, 0.71, C.accent, "reputation price")}
        <Note x={252} y={160} size={11} fill={C.ink}>The sharps&apos; read stays visible.</Note>
      </svg>
    );
  }
  // insider: Today the long shot pays and that's all. Kleos: the money still pays; the reputation is held.
  return (
    <svg {...common} aria-label="Today an insider's long shot pays out. In Kleos the money still pays, but the reputation gain is flagged and held, so it gives no influence over the odds.">
      {frame}
      <Big x={8} y={80} size={24} fill={C.lavender}>$33K</Big>
      <path d="M88 72 h30" stroke={C.faint} strokeWidth={2} />
      <Big x={124} y={80} size={24} fill={C.ink}>$400K</Big>
      <Note x={8} y={108} size={11}>bets placed on classified info,</Note>
      <Note x={8} y={122} size={11}>allegedly</Note>
      <Note x={8} y={160} size={11} fill={C.faint}>Paid out, caught later.</Note>
      <rect x={252} y={44} width={96} height={30} rx={8} fill="none" stroke={C.lavender} />
      <Label x={300} y={63} fill={C.lavender} size={10} anchor="middle">$ still pays</Label>
      <rect x={358} y={44} width={110} height={30} rx={8} fill={C.alt} stroke={C.accent} strokeDasharray="3 3" />
      <Label x={413} y={63} fill={C.accent} size={10} anchor="middle">+R held</Label>
      <Note x={252} y={102} size={11}>New account, long shot, big bet:</Note>
      <Note x={252} y={116} size={11}>flagged, reputation stops vesting.</Note>
      <Note x={252} y={160} size={11} fill={C.ink}>Paid, but no voice in the odds.</Note>
    </svg>
  );
}

// ─── From close to payout ─────────────────────────────────────────────────────

/** The court as four panels, all visible: proposal, dispute, a no-stake jury, a hidden vote revealed. */
export function CourtStrip() {
  const W = 155, gap = 10;
  const px = (i: number) => i * (W + gap);
  const panel = (i: number, n: string, title: string, body: React.ReactNode, foot: string) => (
    <g key={n} transform={`translate(${px(i)} 0)`}>
      <rect x={0} y={0} width={W} height={220} rx={14} fill={C.alt} />
      <Label x={12} y={22} fill={C.accent} size={10}>{n}</Label>
      <Note x={12} y={44} fill={C.ink} size={13}>{title}</Note>
      {body}
      <Note x={12} y={206} size={11}>{foot}</Note>
    </g>
  );
  return (
    <svg viewBox="0 0 650 220" className="h-auto w-full" role="img" aria-label="Court in four steps: someone proposes YES with a 10 dollar bond; someone disputes with 15 dollars; five jurors with no position are drawn; they vote in secret, reveal, and three matching votes decide.">
      {panel(0, "01", "Proposed: YES", (
        <g>
          <rect x={30} y={76} width={94} height={56} rx={10} fill="none" stroke={C.ink} strokeWidth={2} />
          <Big x={77} y={114} size={22} anchor="middle">YES</Big>
          <Label x={77} y={156} fill={C.muted} size={10} anchor="middle">$10 bond</Label>
        </g>
      ), "Needs tier II, no position.")}
      {panel(1, "02", "Disputed", (
        <g>
          <rect x={30} y={76} width={94} height={56} rx={10} fill="none" stroke={C.ink} strokeWidth={2} strokeOpacity={0.4} />
          <Big x={77} y={114} size={22} anchor="middle" fill={C.faint}>YES</Big>
          <path d="M22 140 L132 68" stroke={C.lavender} strokeWidth={3} strokeLinecap="round" />
          <Label x={77} y={156} fill={C.lavender} size={10} anchor="middle">$15 bond</Label>
        </g>
      ), "Anyone but the proposer.")}
      {panel(2, "03", "Jury drawn", (
        <g>
          {Array.from({ length: 10 }, (_, k) => {
            const x = 22 + (k % 5) * 27, y = 78 + Math.floor(k / 5) * 34, held = [1, 6, 8].includes(k);
            const seated = [0, 2, 4, 5, 9].includes(k);
            return (
              <g key={k}>
                <circle cx={x} cy={y} r={10} fill={seated ? C.accent : C.card} stroke={held ? C.faint : C.lineStrong} strokeWidth={1.5} />
                {held && <path d={`M${x - 6} ${y - 6} L${x + 6} ${y + 6}`} stroke={C.faint} strokeWidth={2} />}
              </g>
            );
          })}
          <Label x={12} y={160} fill={C.muted} size={9}>● seated ✕ has a stake</Label>
        </g>
      ), "5 tier-V, no stake.")}
      {panel(3, "04", "Secret, then shown", (
        <g>
          {[0, 1, 2, 3, 4].map((k) => (
            <g key={k}>
              <circle cx={22 + k * 27} cy={82} r={10} fill={C.lineStrong} />
              <Label x={22 + k * 27} y={86} fill={C.muted} size={8} anchor="middle">•••</Label>
            </g>
          ))}
          <path d="M77 98 v12" stroke={C.faint} strokeWidth={2} />
          {(["YES", "YES", "NO", "YES", null] as const).map((v, k) => (
            <g key={k}>
              <circle cx={22 + k * 27} cy={128} r={10} fill={v === "YES" ? C.accent : v === "NO" ? C.lavender : C.card} stroke={C.lineStrong} />
              <Label x={22 + k * 27} y={132} fill={v ? C.ground : C.faint} size={7} anchor="middle">{v ?? "—"}</Label>
            </g>
          ))}
          <Big x={77} y={174} size={18} anchor="middle" fill={C.accent}>3 of 5 · YES</Big>
        </g>
      ), "Ambiguous → refund all.")}
    </svg>
  );
}

/**
 * Two winners each staked $100 against a $1,000 losing side. Their payout is identical; only the
 * 2% bonus is split by ΔR × M, and both gained the same ΔR at the same price.
 */
export function PayoutSplit() {
  const winners = [
    { who: "Newcomer · M 1×", bonus: 5, lit: 0 },
    { who: "Sharp · M 3×", bonus: 15, lit: 5 },
  ];
  const k = 0.42; // px per $
  return (
    <svg viewBox="0 0 640 260" className="h-auto w-full" role="img" aria-label="Two winners staked 100 dollars each against a 1,000 dollar losing side. Each gets the stake back plus 485 dollars. The 20 dollar bonus splits 5 and 15 by reputation. 10 dollars goes to the protocol.">
      <Label x={14} y={22}>Losing side: $1,000 → 97% to winners · 2% bonus · 1% protocol</Label>
      {winners.map((w, i) => {
        const y = 52 + i * 78;
        let x = 190;
        const seg = (amount: number, color: string, label: string, dark = false) => {
          const el = (
            <g key={label}>
              <rect x={x} y={y} width={amount * k} height={34} rx={4} fill={color} />
              {amount * k > 40 && <Label x={x + 8} y={y + 22} fill={dark ? C.ground : C.ink} size={11}>{label}</Label>}
            </g>
          );
          x += amount * k + 2;
          return el;
        };
        return (
          <g key={w.who}>
            <Laurel x={14} y={y - 8} size={48} lit={w.lit} />
            <Note x={70} y={y + 22} fill={C.ink} size={13}>{w.who}</Note>
            {seg(100, C.lineStrong, "$100 back")}
            {seg(485, C.lavender, "+$485 from the losers", true)}
            <rect x={x} y={y} width={Math.max(w.bonus * k * 3, 6)} height={34} rx={4} fill={C.accent} />
            <Label x={x + Math.max(w.bonus * k * 3, 6) + 8} y={y + 22} fill={C.accent} size={12}>+${w.bonus}</Label>
          </g>
        );
      })}
      <line x1={14} x2={626} y1={206} y2={206} stroke={C.line} />
      <Note x={14} y={232} fill={C.ink} size={13}>The money part is identical: winners split the losers&apos; money by stake.</Note>
      <Note x={14} y={250} size={12}>Reputation only tilts the small bonus. (Bonus bars drawn 3× wider to be visible.)</Note>
    </svg>
  );
}

// ─── Tech footprint ──────────────────────────────────────────────────────────

/** What a new user never has to touch. */
export function NoSetup() {
  const never = ["Wallet extension", "Seed phrase", "Buying gas"];
  return (
    <svg viewBox="0 0 640 214" className="h-auto w-full" role="img" aria-label="No wallet extension, no seed phrase, no gas to buy: one touch with a passkey places the first bet, on Monad with 300 millisecond blocks, 600 millisecond finality, near-zero fees and full EVM.">
      {never.map((n, i) => {
        const y = 30 + i * 42;
        return (
          <g key={n}>
            <rect x={14} y={y} width={200} height={30} rx={8} fill={C.alt} />
            <Note x={28} y={y + 20} size={13} fill={C.muted}>{n}</Note>
            <line x1={24} x2={204} y1={y + 15} y2={y + 15} stroke={C.accent} strokeWidth={2} />
          </g>
        );
      })}
      <path d="M232 86 h50" stroke={C.faint} strokeWidth={2} />
      {[8, 14, 20, 26, 32].map((r) => (
        <path key={r} d={`M${330 - r},92 A${r},${r} 0 0 1 ${330 + r},92`} fill="none" stroke={C.accent} strokeWidth={2.4} strokeLinecap="round" />
      ))}
      <path d="M330 82 v26" stroke={C.accent} strokeWidth={2.4} strokeLinecap="round" />
      <path d="M380 86 h50" stroke={C.faint} strokeWidth={2} />
      <circle cx={470} cy={86} r={28} fill={C.accent} />
      <path d="M458 86 l8 9 l16 -18" fill="none" stroke={C.ground} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />
      <Note x={330} y={146} anchor="middle" fill={C.ink} size={13}>One touch</Note>
      <Note x={470} y={146} anchor="middle" fill={C.ink} size={13}>First bet placed</Note>
      <Note x={530} y={80} size={11}>gas and test USD</Note>
      <Note x={530} y={96} size={11}>are sponsored</Note>
      {/* Why it feels instant: Monad's own figures (monad.xyz). */}
      <rect x={14} y={172} width={612} height={34} rx={10} fill={C.alt} />
      <Label x={28} y={194} fill={C.accent} size={10}>On Monad</Label>
      {([["300 ms", "blocks"], ["600 ms", "finality"], ["near-zero", "fees"], ["full", "EVM"]] as const).map(([v, l], i) => (
        <g key={l}>
          <text x={120 + i * 128} y={194} fill={C.ink} fontSize={12} className="font-mono">{v}</text>
          <Label x={120 + i * 128 + v.length * 7.6 + 8} y={194} size={10}>{l}</Label>
        </g>
      ))}
    </svg>
  );
}

/** A real profile row, expanded into the formula and the on-chain event it came from. */
export function CheckTheMath() {
  return (
    <svg viewBox="0 0 640 200" className="h-auto w-full" role="img" aria-label="A profile row showing plus 0.50 reputation expands into the formula one times one times one minus 0.50, and into the ReputationChanged event on Monad with the same numbers.">
      <rect x={14} y={18} width={190} height={54} rx={10} fill={C.alt} stroke={C.line} />
      <Laurel x={22} y={26} size={36} lit={7} />
      <Note x={64} y={42} fill={C.ink} size={12}>@kleos_maxi</Note>
      <Label x={64} y={60} fill={C.accent} size={13}>+0.50 R</Label>
      <path d="M204 45 h30" stroke={C.faint} strokeWidth={2} />
      <rect x={234} y={18} width={190} height={54} rx={10} fill="none" stroke={C.lineStrong} />
      <Label x={246} y={38} fill={C.muted} size={10}>Right at 50%</Label>
      <text x={246} y={60} fill={C.ink} fontSize={13} className="font-mono">1·1·(1 − 0.50) = +0.50</text>
      <path d="M424 45 h30" stroke={C.faint} strokeWidth={2} />
      <rect x={454} y={18} width={172} height={54} rx={10} fill="none" stroke={C.accent} />
      <Label x={466} y={38} fill={C.accent} size={10}>On Monad</Label>
      <text x={466} y={60} fill={C.muted} fontSize={11} className="font-mono">tx 0xd2…dcda ↗</text>
      <rect x={14} y={96} width={612} height={76} rx={10} fill={C.alt} />
      <text x={30} y={124} fill={C.accent} fontSize={12} className="font-mono">ReputationChanged(</text>
      <text x={30} y={146} fill={C.ink} fontSize={12} className="font-mono">  user = kleos_maxi, market = 7, delta = +0.50, entryPrice = 0.50,</text>
      <text x={30} y={164} fill={C.ink} fontSize={12} className="font-mono">  side = YES, outcome = YES, newR = 41.20 )</text>
    </svg>
  );
}
