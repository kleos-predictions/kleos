// Case studies for the compare page. Facts and figures here are limited to what the listed
// sources support; don't add numbers without a source.

export type Case = {
  id: string;
  featured?: boolean; // shown on the compare page; the rest are kept for the pitch
  title: string;
  platform: "Polymarket" | "Kalshi";
  date: string;
  volume?: string;
  happened: string;
  decided: string;
  kleos: string;
  mechanisms: string[];
  limit: string;
  sources: { label: string; url: string }[];
};

export const CASES: Case[] = [
  {
    id: "suit",
    featured: true,
    title: "Zelensky's suit",
    platform: "Polymarket",
    date: "Jun–Jul 2025",
    volume: "More than $200M",
    happened:
      "“Will Zelensky wear a suit before July?” At the June 24 NATO summit he wore a black blazer, collared shirt and suit trousers; many outlets called it a suit.",
    decided:
      "First resolved “Yes”. After challenges it went to a UMA token-holder vote, which ruled “No” on July 1, citing a lack of consensus in credible reporting.",
    kleos:
      "A dispute goes to the Kleos Court: 5 jurors with earned reputation and no position, voting in secret. They can rule AMBIGUOUS, which voids the market and refunds everyone instead of forcing a winner.",
    mechanisms: ["Kleos Court", "No-stake jurors", "AMBIGUOUS → refund"],
    limit:
      "The jury can refund an ambiguous market, but it can't make the question clear after the fact. Clear definitions at creation are still the real fix.",
    sources: [
      { label: "Decrypt", url: "https://decrypt.co/329210/polymarket-rules-no-237m-bet-zelenskyys" },
      { label: "DL News", url: "https://www.dlnews.com/articles/markets/polymarket-bettors-clash-over-zelenskyy-suit-dispute/" },
    ],
  },
  {
    id: "minerals",
    title: "Ukraine minerals deal",
    platform: "Polymarket",
    date: "Mar 2025",
    volume: "More than $7M",
    happened: "The market resolved “Yes” before any deal was reached. Polymarket did not issue refunds.",
    decided:
      "UMA token vote. A threat researcher alleged one whale with three accounts and 5M UMA tokens cast about 25% of the votes. Disputed: others called it negligence, not an attack.",
    kleos:
      "No token voting. Proposers need earned reputation and a bond. A dispute goes to 5 randomly drawn tier-V jurors with no position, voting in secret; 3 of 5 decide.",
    mechanisms: ["Kleos Court", "Random jury", "No-stake jurors"],
    limit:
      "High-reputation jurors could still collude or take open bribes. Random draws, bonds and reputation loss make it costly, not impossible.",
    sources: [
      { label: "The Defiant", url: "https://thedefiant.io/news/defi/polymarket-s-usd7m-ukraine-mineral-deal-debacle-traced-to-oracle-whale" },
      { label: "Cointelegraph", url: "https://cointelegraph.com/news/polymarket-trump-ukraine-bet-whale-governance-attack" },
    ],
  },
  {
    id: "venezuela",
    title: "“Will the US invade Venezuela?”",
    platform: "Polymarket",
    date: "Jan 2026",
    volume: "More than $10.5M on invasion-related contracts",
    happened:
      "After the operation that captured Maduro, Polymarket ruled it was not an “invasion” and would only resolve “Yes” for a military offensive intended to establish control over Venezuelan territory. Traders accused it of changing the rules after the fact.",
    decided: "A platform clarification of its own rules.",
    kleos:
      "Resolution criteria are written at creation, stored on-chain and shown before you bet. The text can't be edited afterward, and proposals and disputes are judged against it.",
    mechanisms: ["Criteria on-chain", "Shown before you bet"],
    limit: "If the original wording is vague, the dispute still happens. Kleos moves the fix to creation time.",
    sources: [
      { label: "Cryptopolitan", url: "https://www.cryptopolitan.com/polymarket-refuses-pay-us-would-venezuela/" },
      {
        label: "Benzinga",
        url: "https://www.benzinga.com/markets/tech/26/01/49745717/polymarket-traders-fume-as-prediction-platform-refuses-to-settle-bets-worth-over-10-million-on-us-invasion-of-venezuela-you-cannot-change-rules",
      },
    ],
  },
  {
    id: "insider",
    title: "Maduro insider trading",
    platform: "Polymarket",
    date: "Dec 2025–Apr 2026",
    happened:
      "A soldier was charged with allegedly using classified information to bet about $33,034 on Maduro-related markets, profiting over $400,000. He has pleaded not guilty. Polymarket flagged the activity and referred it to authorities.",
    decided: "Bets were paid out; the case went to prosecutors in April 2026.",
    kleos:
      "Military operations aren't a market category, so the market can't exist. A new account winning an improbable bet is flagged and its reputation gains stop vesting, so an insider gains no influence over the odds.",
    mechanisms: ["Category allowlist", "Anomaly flag", "Vesting"],
    limit:
      "Kleos can't stop someone from profiting with money on an allowed market. It only denies them reputation and voice.",
    sources: [
      { label: "US DOJ", url: "https://www.justice.gov/opa/pr/us-soldier-charged-using-classified-information-profit-prediction-market-bets" },
      { label: "PBS", url: "https://www.pbs.org/newshour/nation/u-s-soldier-pleads-not-guilty-to-using-maduro-raid-intel-to-win-400000-on-polymarket" },
    ],
  },
  {
    id: "khamenei",
    featured: true,
    title: "Khamenei “out as Supreme Leader?”",
    platform: "Kalshi",
    date: "Feb–Mar 2026",
    volume: "More than $50M",
    happened:
      "After Khamenei was killed, Kalshi did not pay “Yes”. It settled at the last traded price before his death, citing a rule against profiting from death.",
    decided:
      "The exchange rulebook, through a carve-out many traders say they hadn't seen. Kalshi said it would reimburse all fees and fully refund anyone who bet after the death. A class action followed.",
    kleos:
      "Every resolution rule, including exceptions, is stored on-chain with the market and shown on the bet screen before you confirm.",
    mechanisms: ["Criteria on-chain", "Shown before you bet"],
    limit:
      "This was a disclosure problem more than a manipulation problem. Kleos helps by making rules visible and fixed, not by changing who decides.",
    sources: [
      { label: "Forbes", url: "https://www.forbes.com/sites/jasonbrett/2026/03/12/kalshi-death-bet-lawsuit-sparks-push-to-ban-assassination-markets/" },
      { label: "The Block", url: "https://www.theblock.co/post/391678/kalshi-ceo-defends-khamenei-market-design-after-backlash-says-platform-will-reimburse-all-fees" },
    ],
  },
];

export const MATRIX: { label: string; traditional: string; kleos: string }[] = [
  { label: "Who creates markets", traditional: "The platform's team", kleos: "The team and tier-V traders, with a bond they lose if the question is ruled ambiguous" },
  { label: "Who sets the price", traditional: "Money only", kleos: "Money, plus a reputation-weighted price beside it" },
  { label: "Who resolves", traditional: "Token holders or the platform", kleos: "Earned reputation, no position in the market" },
  { label: "Resolution rules", traditional: "Often clarified after the fact", kleos: "Written on-chain before the first bet, shown before you confirm" },
  { label: "A whale's edge", traditional: "Moves the headline odds", kleos: "Moves the money price; the signal holds" },
  { label: "Forecaster track record", traditional: "Invisible", kleos: "Public, on-chain, auditable per bet" },
  { label: "Insider long shots", traditional: "Paid out, caught later if at all", kleos: "Flagged, reputation gains held for review" },
  { label: "Payout per dollar", traditional: "Same for everyone", kleos: "Same for everyone, plus a bonus for beating the market" },
  { label: "Disputes", traditional: "Token-weighted votes, voters may hold positions", kleos: "Kleos Court: 5 random tier-V jurors, no stake, hidden votes, can refund ambiguous markets" },
  { label: "Opinions", traditional: "Comments, detached from bets and never scored", kleos: "Calls tied to real bets, public before the outcome, scored after it" },
  { label: "Getting started", traditional: "Wallet extension, seed phrase, bridge funds", kleos: "A passkey. Gas and test money are sponsored" },
];

export const FEATURED_CASES = CASES.filter((c) => c.featured);
