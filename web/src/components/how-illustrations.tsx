// Illustrations for the How it works page. Static SVG drawn with the design tokens; the moving
// dots are SMIL animations, hidden for people who prefer reduced motion. Numbers match the
// contract's parameters (lib/math.ts).

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

/** A dot that travels along `path`. */
function Traveler({ path, dur, begin = "0s", r = 3, fill = C.accent }: { path: string; dur: string; begin?: string; r?: number; fill?: string }) {
  return (
    <circle r={r} fill={fill} className="motion-reduce:hidden">
      <animateMotion dur={dur} begin={begin} repeatCount="indefinite" path={path} />
    </circle>
  );
}

function Label({ x, y, children, fill = C.muted, size = 11, anchor = "middle" }: { x: number; y: number; children: React.ReactNode; fill?: string; size?: number; anchor?: "start" | "middle" | "end" }) {
  return (
    <text x={x} y={y} fill={fill} fontSize={size} textAnchor={anchor} className="font-mono uppercase" letterSpacing="0.08em">
      {children}
    </text>
  );
}

// Dot-matrix laurel (brand geometry), for use inside other SVGs.
const STEM: [number, number][] = [[28, 57], [21, 53], [16, 47], [13, 40], [12, 32], [13, 24], [16, 17]];
const LEAF: [number, number][] = [[21, 59], [13, 55], [8, 49], [5, 41], [5, 32], [6, 23], [10, 15]];
function LaurelGlyph({ x, y, size, lit = 7 }: { x: number; y: number; size: number; lit?: number }) {
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

/** The whole product as one loop: bet → two prices → resolution → payout and ΔR → weight → bet. */
export function KleosLoop() {
  const cx = 320, cy = 175, r = 110;
  const nodes = [
    { a: -90, title: "BET", sub: "money × M", color: C.ink },
    { a: -18, title: "TWO PRICES", sub: "money · reputation", color: C.lavender },
    { a: 54, title: "RESOLVE", sub: "propose · court", color: C.ink },
    { a: 126, title: "SETTLE", sub: "money pays money", color: C.ink },
    { a: 198, title: "REPUTATION", sub: "ΔR from surprise", color: C.accent },
  ];
  const at = (deg: number) => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)] as const;
  const ring = `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r}`;
  return (
    <svg viewBox="0 0 640 350" className="h-auto w-full" role="img" aria-label="The Kleos loop: bet, two prices, resolve, settle, reputation, which feeds the next bet's weight">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={C.lineStrong} strokeWidth={2} strokeDasharray="2 7" />
      <Traveler path={ring} dur="9s" r={4} />
      <Traveler path={ring} dur="9s" begin="-4.5s" r={3} fill={C.lavender} />
      <LaurelGlyph x={cx - 32} y={cy - 40} size={64} />
      <Label x={cx} y={cy + 40} fill={C.faint} size={10}>weight</Label>
      {nodes.map((n) => {
        const [x, y] = at(n.a);
        const cos = Math.cos((n.a * Math.PI) / 180), sin = Math.sin((n.a * Math.PI) / 180);
        // Labels sit outside the ring: beside side nodes, above the top one, below the bottom ones.
        const side = cos > 0.3 ? "start" : cos < -0.3 ? "end" : "middle";
        const lx = side === "start" ? x + 18 : side === "end" ? x - 18 : x;
        const ly = side === "middle" ? (sin < 0 ? y - 34 : y + 30) : y - 2;
        return (
          <g key={n.title}>
            <circle cx={x} cy={y} r={9} fill={C.card} stroke={n.color} strokeWidth={2.5} />
            <Label x={lx} y={ly} fill={n.color} size={12} anchor={side}>{n.title}</Label>
            <Label x={lx} y={ly + 16} fill={C.faint} size={10} anchor={side}>{n.sub}</Label>
          </g>
        );
      })}
    </svg>
  );
}

/** One small pictogram per failure on the Why Kleos cards. */
export function FailureGlyph({ kind }: { kind: "capture" | "conflict" | "distortion" | "insider" }) {
  const common = { viewBox: "0 0 240 90", className: "h-auto w-full", role: "img" as const };
  if (kind === "capture") {
    // One token whale outvotes the room; Kleos gates resolvers by earned reputation.
    return (
      <svg {...common} aria-label="One large token holder outweighs many small voters">
        <circle cx={52} cy={45} r={30} fill={C.lavender} fillOpacity={0.85} />
        <Label x={52} y={49} fill={C.ground} size={10}>tokens</Label>
        {[0, 1, 2, 3, 4, 5].map((i) => <circle key={i} cx={104 + (i % 3) * 16} cy={33 + Math.floor(i / 3) * 22} r={5} fill={C.lineStrong} />)}
        <path d="M160 45 h24" stroke={C.faint} strokeWidth={2} />
        <LaurelGlyph x={190} y={18} size={52} lit={6} />
      </svg>
    );
  }
  if (kind === "conflict") {
    // A judge with money in the market can't sit.
    return (
      <svg {...common} aria-label="A juror holding a position is excluded">
        {[0, 1, 2, 3, 4].map((i) => {
          const x = 30 + i * 46, held = i === 2;
          return (
            <g key={i}>
              <circle cx={x} cy={40} r={14} fill={held ? C.alt : C.card} stroke={held ? C.faint : C.lineStrong} strokeWidth={2} />
              {held && (
                <>
                  <rect x={x + 6} y={22} width={22} height={13} rx={4} fill={C.lavender} />
                  <Label x={x + 17} y={32} fill={C.ground} size={8}>$</Label>
                  <path d={`M${x - 10} ${30} L${x + 10} ${50}`} stroke={C.accent} strokeWidth={2.5} strokeLinecap="round" />
                </>
              )}
            </g>
          );
        })}
        <Label x={120} y={80} fill={C.faint} size={9}>position → can&apos;t judge</Label>
      </svg>
    );
  }
  if (kind === "distortion") {
    // Eleven linked wallets drag the money price; the reputation price stays put.
    return (
      <svg {...common} aria-label="Eleven linked wallets move the money price but not the reputation price">
        {Array.from({ length: 11 }, (_, i) => (
          <circle key={i} cx={18 + (i % 4) * 16} cy={22 + Math.floor(i / 4) * 18} r={5} fill={C.lavender} />
        ))}
        <path d="M18 22 L66 58" stroke={C.lavender} strokeOpacity={0.35} />
        <path d="M84 45 h16" stroke={C.faint} strokeWidth={2} />
        <rect x={110} y={24} width={120} height={10} rx={5} fill={C.alt} />
        <rect x={110} y={24} width={34} height={10} rx={5} fill={C.lavender} />
        <rect x={110} y={52} width={120} height={10} rx={5} fill={C.alt} />
        <rect x={110} y={52} width={82} height={10} rx={5} fill={C.accent} />
        <Label x={110} y={18} fill={C.lavender} size={9} anchor="start">money</Label>
        <Label x={110} y={76} fill={C.accent} size={9} anchor="start">reputation</Label>
      </svg>
    );
  }
  // insider: a long-shot win waits, capped, before it counts.
  return (
    <svg {...common} aria-label="A long-shot win is capped and vests before it counts">
      <rect x={14} y={30} width={56} height={30} rx={8} fill={C.accent} />
      <Label x={42} y={50} fill={C.ground} size={11}>+R</Label>
      <path d="M78 45 H210" stroke={C.lineStrong} strokeWidth={2} strokeDasharray="2 6" />
      {[0, 1, 2, 3, 4, 5, 6].map((d) => <circle key={d} cx={92 + d * 18} cy={45} r={3.5} fill={d < 3 ? C.accent : C.off} />)}
      <circle cx={222} cy={45} r={11} fill="none" stroke={C.muted} strokeWidth={2} />
      <path d="M222 38 v7 l5 4" stroke={C.muted} strokeWidth={2} fill="none" strokeLinecap="round" />
      <Label x={146} y={78} fill={C.faint} size={9}>capped · vests · reviewed</Label>
    </svg>
  );
}

/** Where a market's losing pool goes. */
export function MoneyFlow() {
  const sinks = [
    { y: 26, h: 120, label: "WINNERS", sub: "$970 · split by stake", color: C.ink, w: 110, op: 0.18, dots: 6 },
    { y: 164, h: 46, label: "BONUS", sub: "$20 · by ΔR⁺ × M", color: C.accent, w: 4, op: 0.6, dots: 2 },
    { y: 224, h: 32, label: "PROTOCOL", sub: "$10", color: C.muted, w: 2, op: 0.6, dots: 1 },
  ];
  return (
    <svg viewBox="0 0 640 270" className="h-auto w-full" role="img" aria-label="A losing pool of 1,000 dollars: 970 to winners by stake, 20 to the bonus, 10 to the protocol">
      <rect x={16} y={60} width={140} height={140} rx={18} fill={C.alt} stroke={C.lavender} strokeOpacity={0.6} />
      <Label x={86} y={90} fill={C.lavender}>losing side</Label>
      <text x={86} y={140} fill={C.ink} fontSize={28} textAnchor="middle" className="font-dot" fontWeight={900}>$1,000</text>
      <Label x={86} y={226} fill={C.faint} size={9}>winners also get</Label>
      <Label x={86} y={240} fill={C.faint} size={9}>their stake back</Label>
      {sinks.map((k, i) => {
        const ty = k.y + k.h / 2;
        const d = `M156,130 C300,130 320,${ty} 456,${ty}`;
        return (
          <g key={k.label}>
            <path d={d} fill="none" stroke={k.color} strokeOpacity={k.op} strokeWidth={k.w} />
            {Array.from({ length: k.dots }, (_, j) => (
              <Traveler key={j} path={d} dur={`${2.6 + i * 0.5}s`} begin={`${(-j * 2.6) / k.dots}s`} r={i === 0 ? 3.2 : 2.6} fill={k.color} />
            ))}
            <rect x={456} y={k.y} width={168} height={k.h} rx={12} fill={C.alt} stroke={k.color} strokeOpacity={0.55} />
            <Label x={470} y={k.y + (k.h > 40 ? 26 : k.h / 2 + 4)} fill={k.color} anchor="start">{k.label}</Label>
            {k.h > 40 ? (
              <Label x={470} y={k.y + 44} fill={C.muted} size={10} anchor="start">{k.sub}</Label>
            ) : (
              <Label x={612} y={k.y + k.h / 2 + 4} fill={C.muted} size={10} anchor="end">{k.sub}</Label>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Passkey → account → sponsored funds → bet. */
export function PasskeyFlow() {
  const xs = [70, 240, 410, 570];
  const labels = [
    ["Touch ID", "passkey"],
    ["Account", "derived, never stored"],
    ["Funded", "gas + test USD, sponsored"],
    ["Bet placed", "one transaction"],
  ];
  return (
    <svg viewBox="0 0 640 190" className="h-auto w-full" role="img" aria-label="Passkey, account, funded, bet placed">
      <Label x={20} y={22} fill={C.muted} anchor="start">0 seed phrases · 0 extensions · 0 gas to buy</Label>
      {xs.slice(0, -1).map((x, i) => {
        const d = `M${x + 40},96 L${xs[i + 1] - 40},96`;
        return (
          <g key={x}>
            <path d={d} stroke={C.lineStrong} strokeWidth={2} strokeDasharray="2 6" />
            <Traveler path={d} dur="1.8s" begin={`${-i * 0.6}s`} />
          </g>
        );
      })}
      {/* fingerprint */}
      {[6, 11, 16, 21, 26].map((r) => (
        <path key={r} d={`M${70 - r},100 A${r},${r} 0 0 1 ${70 + r},100`} fill="none" stroke={C.accent} strokeWidth={2.2} strokeLinecap="round" />
      ))}
      <path d="M70 92 v20" stroke={C.accent} strokeWidth={2.2} strokeLinecap="round" />
      {/* account: a dot-matrix identicon */}
      {Array.from({ length: 16 }, (_, i) => (
        <circle key={i} cx={218 + (i % 4) * 15} cy={74 + Math.floor(i / 4) * 15} r={4.5} fill={(i * 7) % 3 ? C.ink : C.off} />
      ))}
      {/* funded */}
      <circle cx={410} cy={96} r={24} fill="none" stroke={C.lavender} strokeWidth={2.5} />
      <text x={410} y={104} textAnchor="middle" fill={C.lavender} fontSize={22} className="font-dot" fontWeight={900}>$</text>
      {/* bet */}
      <circle cx={570} cy={96} r={24} fill={C.accent} />
      <path d="M560 96 l7 8 l14 -16" fill="none" stroke={C.ground} strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" />
      {labels.map(([title, sub], i) => (
        <g key={title}>
          <Label x={xs[i]} y={148} fill={C.ink}>{title}</Label>
          <Label x={xs[i]} y={166} fill={C.faint} size={9}>{sub}</Label>
        </g>
      ))}
    </svg>
  );
}

/** Chain events → Envio → profile rows that link back to their transactions. */
export function VerifyPipeline() {
  const blocks = [0, 1, 2, 3, 4, 5];
  const rep = new Set([1, 4]);
  const rows: [string, string][] = [["+0.50", "0xd2…dcda"], ["−0.17", "0x8a…41f0"], ["+0.31", "0x17…2d33"], ["+0.62", "0xda…34ea"]];
  return (
    <svg viewBox="0 0 640 230" className="h-auto w-full" role="img" aria-label="Monad blocks flow through the Envio indexer into a profile whose rows link to their transactions">
      <Label x={20} y={24} anchor="start">Monad · events</Label>
      {blocks.map((i) => {
        const y = 40 + i * 30;
        const d = `M140,${y + 11} C200,${y + 11} 200,115 250,115`;
        return (
          <g key={i}>
            <rect x={20} y={y} width={120} height={22} rx={5} fill={C.alt} stroke={C.line} />
            <Label x={30} y={y + 15} fill={rep.has(i) ? C.accent : C.faint} size={9} anchor="start">{rep.has(i) ? "ReputationChanged" : "BetPlaced"}</Label>
            <path d={d} fill="none" stroke={C.line} strokeWidth={1.5} />
            <Traveler path={d} dur="2.4s" begin={`${-i * 0.4}s`} r={2.6} fill={rep.has(i) ? C.accent : C.faint} />
          </g>
        );
      })}
      <rect x={250} y={70} width={130} height={90} rx={16} fill={C.alt} stroke={C.accent} strokeOpacity={0.6} />
      <text x={315} y={110} textAnchor="middle" fill={C.ink} fontSize={18} className="font-dot" fontWeight={900}>ENVIO</text>
      <Label x={315} y={130} fill={C.muted} size={10}>HyperIndex</Label>
      <path d="M380 115 H440" stroke={C.accent} strokeWidth={2} />
      <rect x={440} y={30} width={180} height={180} rx={16} fill={C.alt} stroke={C.line} />
      <LaurelGlyph x={452} y={40} size={28} />
      <text x={486} y={58} fill={C.ink} fontSize={11} className="font-mono">@kleos_maxi</text>
      {rows.map(([dr, tx], i) => {
        const y = 92 + i * 28;
        return (
          <g key={tx}>
            <line x1={452} x2={608} y1={y - 16} y2={y - 16} stroke={C.line} />
            <text x={456} y={y} fill={dr.startsWith("+") ? C.accent : C.lavender} fontSize={12} className="font-mono">{dr}</text>
            <text x={604} y={y} fill={C.muted} fontSize={10} textAnchor="end" className="font-mono">{tx} ↗</text>
          </g>
        );
      })}
      <Label x={530} y={226} fill={C.faint} size={9}>every row → its transaction</Label>
    </svg>
  );
}
