// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @title Kleos
/// @notice Parimutuel prediction market with a verifiable reputation layer.
///
///   Money pays money. Reputation steers the signal and earns a fee-funded bonus.
///
///   Multiplier     M  = min(1 + α·√R, M_max)          (1.0 until N_MIN resolved bets)
///   Effective bet  E  = m · M                          (drives the reputation-weighted price only)
///   Prices         P_money = YES$ / total$     P_rep = YES_E / total_E
///   Payout         m + (m / ΣwinningMoney) · (L − fees)      fees = FEE_BPS (bonus) + PROTOCOL_FEE_BPS of L
///   Bonus          bonusPool · w / Σw,  w = ΔR⁺ · M          (winners with positive ΔR)
///   Reputation     right: ΔR = +k·s·(1 − p)   wrong: ΔR = −λ·k·s·p
///                  p = rep-weighted price of the chosen side at entry, s = min(m / $50, 1)
///
/// Safeguards: activation after N_MIN resolved bets, vesting of gains, per-market gain cap,
/// minimum market depth, anomaly flag, resolver gating, category allowlist.
///
/// Kleos Court: a disputed proposal goes to 5 jurors drawn from a pool of tier-V traders
/// with no position in the market. Votes are committed, then revealed; 3 matching votes
/// decide YES, NO or AMBIGUOUS (the market is voided and everyone is refunded).
/// Every change to R emits ReputationChanged so anyone can rebuild and audit it.
/// Fixed-point values (R, M, p, s, weights) use 18 decimals. Money uses the token's decimals.
contract Kleos {
    // ─── Parameters ────────────────────────────────────────────────────────────
    uint256 internal constant WAD = 1e18;

    uint256 public constant ALPHA = 0.5e18; // multiplier slope on √R
    uint256 public constant M_MAX = 5e18; // multiplier ceiling
    uint256 public constant K = 1e18; // reputation step
    uint256 public constant LAMBDA = 1.5e18; // losses hurt 1.5× more than wins help
    uint256 public constant STAKE_REF = 50e6; // stakes ≥ $50 count fully (s = 1)
    uint256 public constant BOOST_CAP = 0.1e18; // an address's boost stops at 10% of the effective pool
    uint256 public constant BOOST_CAP_MIN_POOL = 5_000e6; // cap applies once the pool is this deep
    uint256 public constant MIN_BET = 1e6;
    uint256 public constant MAX_CALL_BYTES = 140; // a call: the public one-line reason behind a bet
    uint256 public constant BOND = 10e6; // resolution bond
    uint256 public constant FEE_BPS = 200; // 2% of the losing pool funds the market's bonus
    uint256 public constant PROTOCOL_FEE_BPS = 100; // 1% of the losing pool is protocol revenue
    uint256 public constant DELTA_R_MAX = 0.8e18; // max reputation gain from a single market (blunts long-shot windfalls)
    uint256 public constant MIN_REP_POOL = 1_000e6; // reputation only moves in markets this deep…
    uint256 public constant MIN_BETTORS = 10; // …with at least this many distinct bettors
    uint256 public constant FLAG_PRICE = 0.1e18; // long-shot threshold for the anomaly flag
    uint256 public constant FLAG_SIZE = 100e6; // size threshold for the anomaly flag
    uint256 public constant RESOLVER_MIN_R = 4e18; // tier II to propose
    uint256 public constant CREATOR_MIN_R = 36e18; // tier V (or the team) to create markets
    uint256 public constant CREATION_BOND = 25e6; // back on a clean resolution, lost if the court rules AMBIGUOUS
    uint256 public constant CREATION_FEE = 2e6; // protocol revenue per market

    // Kleos Court
    uint256 public constant DISPUTE_BOND = 15e6; // disputing just because you lost costs money
    uint256 public constant JUROR_MIN_R = 36e18; // tier V to sit in the jury pool
    uint256 public constant JURY_SIZE = 5;
    uint256 public constant QUORUM = 3; // 3 of 5 matching votes decide
    uint256 public constant MAX_ROUNDS = 2; // one redraw, then the market is voided
    uint256 public constant JUROR_REWARD = 0.3e18; // voting with the verdict (vests)
    uint256 public constant JUROR_PENALTY = 0.3e18; // voting against it
    uint256 public constant NO_SHOW_PENALTY = 1e18; // only when missing votes forced a refund
    uint8 public constant VOTE_YES = 1;
    uint8 public constant VOTE_NO = 2;
    uint8 public constant VOTE_AMBIGUOUS = 3;

    uint256 public immutable DISPUTE_WINDOW;
    uint256 public immutable VEST_PERIOD;
    uint256 public immutable N_MIN; // resolved bets before reputation boosts anything
    uint256 public immutable COURT_PERIOD; // length of the commit phase, and of the reveal phase

    // ─── Storage ───────────────────────────────────────────────────────────────
    enum State {
        Open,
        Proposed,
        Disputed,
        Resolved
    }

    struct Market {
        string question;
        string oracle; // human-readable resolution source
        string criteria; // exactly what makes it resolve YES
        uint8 category;
        uint64 closeTime;
        State state;
        bool outcome; // true = YES
        bool voided; // resolved AMBIGUOUS: everyone is refunded
        bool proposedOutcome;
        uint64 proposedAt;
        address proposer;
        address disputer;
        address creator;
        uint256 creatorBond;
        bytes32 evidenceHash;
        string evidenceURI;
        uint256 yesMoney;
        uint256 noMoney;
        uint256 yesEff;
        uint256 noEff;
    }

    struct Payouts {
        uint256 bonusPool;
        uint256 totalWeight; // Σ ΔR⁺·M of winners
        uint256 settledCount;
        bool bonusOpen;
    }

    struct Position {
        uint256 money;
        uint256 eff;
        uint256 priceSum; // Σ money·p, so the entry price is the money-weighted average
    }

    struct Court {
        uint8 round;
        uint8 revealed;
        uint64 commitEnd;
        uint64 revealEnd;
        uint8[4] tally; // indexed by vote
    }

    struct Rep {
        uint256 r; // vested reputation; the only kind that boosts
        uint256 pending; // gains waiting to vest
        uint64 vestAt;
        uint32 resolvedBets; // markets that counted toward reputation
        bool flagged;
    }

    IERC20 public immutable usd;
    address public owner;
    uint256 public marketCount;
    uint256 public globalBonusPool;
    uint256 public protocolRevenue; // accrued, withdrawable by the owner
    uint256 public callCount; // calls are numbered from 1; the id every other system uses

    mapping(uint8 => string) public categoryName; // allowlist: unset = not allowed
    mapping(uint256 => Market) internal _markets;
    mapping(uint256 => Payouts) public payouts;
    mapping(uint256 => mapping(address => mapping(bool => Position))) public positions;
    mapping(uint256 => address[]) internal _bettors;
    mapping(uint256 => mapping(address => bool)) public hasBet;
    mapping(uint256 => mapping(address => bool)) public settled;
    mapping(uint256 => mapping(address => uint256)) public bonusWeight;
    mapping(uint256 => mapping(address => bool)) public bonusClaimed;
    mapping(address => Rep) internal _rep;

    address[] internal _jurorPool;
    mapping(address => uint256) internal _poolSlot; // index + 1; 0 = not in the pool
    mapping(uint256 => Court) internal _courts;
    mapping(uint256 => mapping(uint8 => address[])) internal _jury;
    mapping(uint256 => mapping(uint8 => mapping(address => bytes32))) public commitments;
    mapping(uint256 => mapping(uint8 => mapping(address => uint8))) public votes;
    mapping(uint256 => mapping(uint8 => bool)) internal _lackedQuorum;

    // ─── Events ────────────────────────────────────────────────────────────────
    event CategoryAdded(uint8 indexed id, string name);
    event MarketCreated(
        uint256 indexed marketId, address indexed creator, string question, uint8 category, string oracle, string criteria, uint64 closeTime
    );
    event CreatorBondReleased(uint256 indexed marketId, address indexed creator, uint256 amount, bool forfeited);
    event BetPlaced(
        uint256 indexed marketId,
        address indexed user,
        bool side,
        uint256 amount,
        uint256 effective,
        uint256 multiplier,
        uint256 entryPrice,
        uint256 priceRepYes,
        uint256 priceMoneyYes
    );
    event Sponsored(uint256 indexed marketId, address indexed sponsor, uint256 amount);
    /// @dev Public and permanent. Emitted only (never stored) to keep it cheap; timestamped before
    ///      the outcome, so after resolution it becomes a receipt.
    event CallPosted(
        uint256 indexed callId, uint256 indexed marketId, address indexed user, bool side, uint256 amount, uint256 entryPrice, string text
    );
    event OutcomeProposed(uint256 indexed marketId, address indexed proposer, bool outcome, bytes32 evidenceHash, string evidenceURI);
    event OutcomeDisputed(uint256 indexed marketId, address indexed disputer);
    event MarketResolved(uint256 indexed marketId, bool outcome, uint256 fee);
    event RevenueAccrued(uint256 indexed marketId, uint256 amount);
    event RevenueWithdrawn(address indexed to, uint256 amount);
    event MarketVoided(uint256 indexed marketId);
    event JurorJoined(address indexed juror);
    event JurorLeft(address indexed juror);
    event JuryDrawn(uint256 indexed marketId, uint8 round, address[] jurors);
    event VoteCommitted(uint256 indexed marketId, uint8 round, address indexed juror);
    event VoteRevealed(uint256 indexed marketId, uint8 round, address indexed juror, uint8 vote);
    event CourtRedrawn(uint256 indexed marketId, uint8 failedRound);
    event Verdict(uint256 indexed marketId, uint8 round, uint8 vote);
    event Settled(uint256 indexed marketId, address indexed user, uint256 payout, uint256 bonusWeight);
    event BonusOpened(uint256 indexed marketId, uint256 bonusPool, uint256 totalWeight);
    event BonusClaimed(uint256 indexed marketId, address indexed user, uint256 amount);
    event BonusRolledOver(uint256 indexed marketId, uint256 amount);
    /// @dev marketId 0 marks demo seeds and admin slashes; they are public like every other change.
    event ReputationChanged(
        address indexed user,
        uint256 indexed marketId,
        int256 delta,
        uint256 newR,
        uint256 pendingR,
        uint256 entryPrice,
        bool side,
        bool outcome
    );
    event Vested(address indexed user, uint256 amount, uint256 newR);
    event Flagged(address indexed user, uint256 indexed marketId);
    event FlagCleared(address indexed user);
    event Slashed(address indexed user, uint256 amount);

    // ─── Errors ────────────────────────────────────────────────────────────────
    error NotOwner();
    error BadState();
    error BadCategory();
    error MarketClosed();
    error MarketNotClosed();
    error BetTooSmall();
    error WindowOpen();
    error WindowClosed();
    error NotEligibleResolver();
    error NotEligibleCreator();
    error BadCloseTime();
    error NotEligibleJuror();
    error NotJuror();
    error BadVote();
    error CallTooLong();
    error NothingToVest();
    error StillVesting();
    error UnderReview();
    error BonusNotOpen();
    error AlreadyClaimed();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IERC20 usd_, uint256 disputeWindow, uint256 vestPeriod, uint256 nMin, uint256 courtPeriod) {
        usd = usd_;
        owner = msg.sender;
        DISPUTE_WINDOW = disputeWindow;
        VEST_PERIOD = vestPeriod;
        N_MIN = nMin;
        COURT_PERIOD = courtPeriod;
        _addCategory(1, "Crypto");
        _addCategory(2, "Sports");
        _addCategory(3, "Tech");
        _addCategory(4, "Culture");
    }

    // ─── Admin ─────────────────────────────────────────────────────────────────
    /// @notice Categories are an allowlist. Blocked topics (military operations, internal
    ///         government decisions) never get an id, so no market can be filed under them.
    function addCategory(uint8 id, string calldata name) external onlyOwner {
        _addCategory(id, name);
    }

    function createMarket(
        string calldata question,
        uint8 category,
        string calldata oracle,
        string calldata criteria,
        uint64 closeTime
    ) external returns (uint256 id) {
        if (bytes(categoryName[category]).length == 0) revert BadCategory();
        if (closeTime <= block.timestamp) revert BadCloseTime();
        id = ++marketCount;
        Market storage m = _markets[id];
        m.creator = msg.sender;
        // The team creates for free. Tier-V traders post a bond (back on a clean resolution) plus a fee.
        if (msg.sender != owner) {
            Rep storage rep = _rep[msg.sender];
            if (rep.r < CREATOR_MIN_R || rep.flagged) revert NotEligibleCreator();
            _pull(msg.sender, CREATION_BOND + CREATION_FEE);
            m.creatorBond = CREATION_BOND;
            protocolRevenue += CREATION_FEE;
            emit RevenueAccrued(id, CREATION_FEE);
        }
        m.question = question;
        m.category = category;
        m.oracle = oracle;
        m.criteria = criteria;
        m.closeTime = closeTime;
        emit MarketCreated(id, msg.sender, question, category, oracle, criteria, closeTime);
    }

    /// @notice Demo-only starting state. Emitted as a public ReputationChanged with marketId 0.
    function seedReputation(address user, uint256 r, uint32 resolvedBets) external onlyOwner {
        Rep storage rep = _rep[user];
        int256 delta = int256(r) - int256(rep.r);
        rep.r = r;
        rep.resolvedBets = resolvedBets;
        emit ReputationChanged(user, 0, delta, r, rep.pending, 0, false, false);
    }

    function clearFlag(address user) external onlyOwner {
        _rep[user].flagged = false;
        emit FlagCleared(user);
    }

    /// @notice Removes reputation after review, pending gains first (they are what was under review).
    function slash(address user, uint256 amount) external onlyOwner {
        Rep storage rep = _rep[user];
        uint256 fromPending = amount > rep.pending ? rep.pending : amount;
        rep.pending -= fromPending;
        uint256 taken = fromPending + _takeReputation(rep, amount - fromPending);
        emit Slashed(user, taken);
        emit ReputationChanged(user, 0, -int256(taken), _rep[user].r, _rep[user].pending, 0, false, false);
    }

    /// @notice Sends accrued protocol revenue to the treasury.
    function withdrawRevenue(address to) external onlyOwner {
        uint256 amount = protocolRevenue;
        protocolRevenue = 0;
        _push(to, amount);
        emit RevenueWithdrawn(to, amount);
    }

    /// @notice Moves rolled-over bonus into a market, e.g. to seed a new one.
    function fundFromGlobal(uint256 id, uint256 amount) external onlyOwner {
        if (_markets[id].state == State.Resolved) revert BadState();
        globalBonusPool -= amount;
        payouts[id].bonusPool += amount;
        emit Sponsored(id, address(this), amount);
    }

    function transferOwnership(address next) external onlyOwner {
        owner = next;
    }

    // ─── Math ──────────────────────────────────────────────────────────────────
    function multiplier(uint256 r) public pure returns (uint256) {
        uint256 m = WAD + (ALPHA * _sqrt(r * WAD)) / WAD;
        return m > M_MAX ? M_MAX : m;
    }

    /// @notice 1.0 until N_MIN resolved bets, then based on vested reputation only.
    function multiplierOf(address user) public view returns (uint256) {
        Rep storage rep = _rep[user];
        if (rep.resolvedBets < N_MIN) return WAD;
        return multiplier(rep.r);
    }

    function reputation(address user) external view returns (Rep memory) {
        return _rep[user];
    }

    /// @return repYes reputation-weighted YES price, moneyYes money-only YES price (both WAD)
    function prices(uint256 id) public view returns (uint256 repYes, uint256 moneyYes) {
        Market storage m = _markets[id];
        uint256 totalEff = m.yesEff + m.noEff;
        uint256 totalMoney = m.yesMoney + m.noMoney;
        repYes = totalEff == 0 ? WAD / 2 : (m.yesEff * WAD) / totalEff;
        moneyYes = totalMoney == 0 ? WAD / 2 : (m.yesMoney * WAD) / totalMoney;
    }

    /// @notice Effective weight a bet would get right now, after the boost cap.
    function quote(uint256 id, address user, uint256 amount) public view returns (uint256 eff, uint256 mult) {
        mult = multiplierOf(user);
        eff = (amount * mult) / WAD;
        if (eff <= amount) return (amount, mult);

        Market storage m = _markets[id];
        uint256 pool = m.yesEff + m.noEff;
        if (pool < BOOST_CAP_MIN_POOL) return (eff, mult);

        // userEff + e ≤ cap·(pool + e)  →  e ≤ (cap·pool − userEff) / (1 − cap)
        uint256 userEff = positions[id][user][true].eff + positions[id][user][false].eff;
        uint256 room = (BOOST_CAP * pool) / WAD;
        uint256 bound = room > userEff ? ((room - userEff) * WAD) / (WAD - BOOST_CAP) : 0;
        if (bound < amount) bound = amount; // the cap trims the boost, never the money
        if (eff > bound) eff = bound;
    }

    // ─── Trading ───────────────────────────────────────────────────────────────
    function bet(uint256 id, bool yes, uint256 amount) external {
        _bet(id, yes, amount);
    }

    /// @notice A bet with a call: a public, permanent one-liner saying why (max 140 bytes).
    function betWithCall(uint256 id, bool yes, uint256 amount, string calldata text) external {
        if (bytes(text).length > MAX_CALL_BYTES) revert CallTooLong();
        uint256 entryPrice = _bet(id, yes, amount);
        if (bytes(text).length > 0) emit CallPosted(++callCount, id, msg.sender, yes, amount, entryPrice, text);
    }

    function _bet(uint256 id, bool yes, uint256 amount) internal returns (uint256 entryPrice) {
        Market storage m = _markets[id];
        if (m.state != State.Open || block.timestamp >= m.closeTime) revert MarketClosed();
        if (amount < MIN_BET) revert BetTooSmall();
        _pull(msg.sender, amount);

        (uint256 repYes,) = prices(id);
        entryPrice = yes ? repYes : WAD - repYes;
        (uint256 eff, uint256 mult) = quote(id, msg.sender, amount);

        Position storage pos = positions[id][msg.sender][yes];
        pos.money += amount;
        pos.eff += eff;
        pos.priceSum += amount * entryPrice;

        if (yes) {
            m.yesMoney += amount;
            m.yesEff += eff;
        } else {
            m.noMoney += amount;
            m.noEff += eff;
        }
        if (!hasBet[id][msg.sender]) {
            hasBet[id][msg.sender] = true;
            _bettors[id].push(msg.sender);
        }

        (uint256 newRepYes, uint256 newMoneyYes) = prices(id);
        emit BetPlaced(id, msg.sender, yes, amount, eff, mult, entryPrice, newRepYes, newMoneyYes);
    }

    /// @notice Anyone can add to a market's bonus. It pays accurate contrarians on either side,
    ///         so sponsoring buys attention, not an outcome.
    function sponsor(uint256 id, uint256 amount) external {
        if (id == 0 || id > marketCount || payouts[id].bonusOpen) revert BadState();
        _pull(msg.sender, amount);
        payouts[id].bonusPool += amount;
        emit Sponsored(id, msg.sender, amount);
    }

    // ─── Resolution: propose → dispute window → finalize, or the Kleos Court ────
    function propose(uint256 id, bool outcome, bytes32 evidenceHash, string calldata evidenceURI) external {
        Market storage m = _markets[id];
        if (m.state != State.Open) revert BadState();
        if (block.timestamp < m.closeTime) revert MarketNotClosed();
        _requireResolver(id);
        _pull(msg.sender, BOND);
        m.state = State.Proposed;
        m.proposedOutcome = outcome;
        m.proposedAt = uint64(block.timestamp);
        m.proposer = msg.sender;
        m.evidenceHash = evidenceHash;
        m.evidenceURI = evidenceURI;
        emit OutcomeProposed(id, msg.sender, outcome, evidenceHash, evidenceURI);
    }

    /// @notice Anyone except the proposer can dispute, bettors included, by posting DISPUTE_BOND.
    ///         One dispute per market; it sends the question to the Kleos Court.
    function dispute(uint256 id) external {
        Market storage m = _markets[id];
        if (m.state != State.Proposed) revert BadState();
        if (block.timestamp >= m.proposedAt + DISPUTE_WINDOW) revert WindowClosed();
        if (msg.sender == m.proposer) revert NotEligibleResolver();
        _pull(msg.sender, DISPUTE_BOND);
        m.state = State.Disputed;
        m.disputer = msg.sender;
        emit OutcomeDisputed(id, msg.sender);
        _drawJury(id, m);
    }

    function finalize(uint256 id) external {
        Market storage m = _markets[id];
        if (m.state != State.Proposed) revert BadState();
        if (block.timestamp < m.proposedAt + DISPUTE_WINDOW) revert WindowOpen();
        _resolve(id, m.proposedOutcome);
        _push(m.proposer, BOND);
    }

    /// @dev Resolvers need earned reputation and no stake in the market they judge.
    function _requireResolver(uint256 id) internal view {
        Rep storage rep = _rep[msg.sender];
        if (hasBet[id][msg.sender] || rep.flagged || rep.r < RESOLVER_MIN_R || msg.sender == _markets[id].creator) {
            revert NotEligibleResolver();
        }
    }

    function _resolve(uint256 id, bool outcome) internal {
        Market storage m = _markets[id];
        m.state = State.Resolved;
        m.outcome = outcome;
        uint256 winMoney = outcome ? m.yesMoney : m.noMoney;
        uint256 losingMoney = outcome ? m.noMoney : m.yesMoney;
        // No fees when nobody picked the winner: everyone is refunded in full.
        uint256 fee = winMoney == 0 ? 0 : (losingMoney * FEE_BPS) / 10_000;
        uint256 revenue = winMoney == 0 ? 0 : (losingMoney * PROTOCOL_FEE_BPS) / 10_000;
        payouts[id].bonusPool += fee;
        protocolRevenue += revenue;
        emit MarketResolved(id, outcome, fee);
        if (revenue > 0) emit RevenueAccrued(id, revenue);
        _releaseCreatorBond(id, m, false);
    }

    /// @dev A clear question gets its bond back. One the court rules AMBIGUOUS loses it to the
    ///      global bonus pool, so writing vague markets costs the person who wrote them.
    function _releaseCreatorBond(uint256 id, Market storage m, bool forfeit) internal {
        uint256 bond = m.creatorBond;
        if (bond == 0) return;
        m.creatorBond = 0;
        if (forfeit) globalBonusPool += bond;
        else _push(m.creator, bond);
        emit CreatorBondReleased(id, m.creator, bond, forfeit);
    }

    function _void(uint256 id, Market storage m) internal {
        m.state = State.Resolved;
        m.voided = true;
        emit MarketVoided(id);
    }

    // ─── Kleos Court ────────────────────────────────────────────────────────────
    function joinCourt() external {
        Rep storage rep = _rep[msg.sender];
        if (rep.r < JUROR_MIN_R || rep.flagged || rep.resolvedBets < N_MIN) revert NotEligibleJuror();
        if (_poolSlot[msg.sender] != 0) return;
        _jurorPool.push(msg.sender);
        _poolSlot[msg.sender] = _jurorPool.length;
        emit JurorJoined(msg.sender);
    }

    function leaveCourt() external {
        uint256 slot = _poolSlot[msg.sender];
        if (slot == 0) return;
        address last = _jurorPool[_jurorPool.length - 1];
        _jurorPool[slot - 1] = last;
        _poolSlot[last] = slot;
        _jurorPool.pop();
        delete _poolSlot[msg.sender];
        emit JurorLeft(msg.sender);
    }

    /// @dev Draws up to JURY_SIZE eligible jurors. On-chain randomness can be nudged by block
    ///      producers; acceptable on testnet, and listed as a known limitation.
    function _drawJury(uint256 id, Market storage m) internal {
        Court storage c = _courts[id];
        c.round++;
        c.revealed = 0;
        delete c.tally;
        c.commitEnd = uint64(block.timestamp + COURT_PERIOD);
        c.revealEnd = uint64(block.timestamp + 2 * COURT_PERIOD);

        address[] storage jury = _jury[id][c.round];
        uint256 n = _jurorPool.length;
        uint256 seed = uint256(keccak256(abi.encode(block.prevrandao, blockhash(block.number - 1), id, c.round)));
        // Random probes first, then a sweep so a small pool still fills the jury.
        for (uint256 i; i < 3 * n + n && jury.length < JURY_SIZE; ++i) {
            uint256 idx = i < 3 * n ? uint256(keccak256(abi.encode(seed, i))) % n : (seed + i) % n;
            address j = _jurorPool[idx];
            if (_eligibleJuror(id, m, c.round, j)) jury.push(j);
        }
        emit JuryDrawn(id, c.round, jury);
    }

    function _eligibleJuror(uint256 id, Market storage m, uint8 round, address j) internal view returns (bool) {
        Rep storage rep = _rep[j];
        if (rep.r < JUROR_MIN_R || rep.flagged || hasBet[id][j] || j == m.proposer || j == m.disputer || j == m.creator) return false;
        if (_onJury(id, round, j)) return false; // already drawn this round
        return round == 1 || !_onJury(id, round - 1, j); // a redraw brings fresh eyes
    }

    function _onJury(uint256 id, uint8 round, address j) internal view returns (bool) {
        address[] storage jury = _jury[id][round];
        for (uint256 i; i < jury.length; ++i) if (jury[i] == j) return true;
        return false;
    }

    function voteCommitment(uint256 id, uint8 round, address juror, uint8 vote, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(id, round, juror, vote, salt));
    }

    /// @notice Jurors commit a hidden vote first, so nobody can copy or pressure a visible tally.
    function commitVote(uint256 id, bytes32 commitment) external {
        Court storage c = _courts[id];
        if (_markets[id].state != State.Disputed || block.timestamp >= c.commitEnd) revert WindowClosed();
        if (!_onJury(id, c.round, msg.sender)) revert NotJuror();
        commitments[id][c.round][msg.sender] = commitment;
        emit VoteCommitted(id, c.round, msg.sender);
    }

    function revealVote(uint256 id, uint8 vote, bytes32 salt) external {
        Court storage c = _courts[id];
        if (_markets[id].state != State.Disputed) revert BadState();
        if (block.timestamp < c.commitEnd) revert WindowOpen();
        if (block.timestamp >= c.revealEnd) revert WindowClosed();
        bytes32 committed = commitments[id][c.round][msg.sender];
        if (vote < VOTE_YES || vote > VOTE_AMBIGUOUS || committed == 0 || votes[id][c.round][msg.sender] != 0) revert BadVote();
        if (committed != voteCommitment(id, c.round, msg.sender, vote, salt)) revert BadVote();
        votes[id][c.round][msg.sender] = vote;
        c.revealed++;
        c.tally[vote]++;
        emit VoteRevealed(id, c.round, msg.sender, vote);
    }

    /// @notice Anyone can close a round once reveals are over, or as soon as every juror revealed.
    function closeCourt(uint256 id) external {
        Market storage m = _markets[id];
        Court storage c = _courts[id];
        if (m.state != State.Disputed) revert BadState();
        uint8 round = c.round;
        if (block.timestamp < c.revealEnd && c.revealed < _jury[id][round].length) revert WindowOpen();

        uint8 verdict;
        for (uint8 v = VOTE_YES; v <= VOTE_AMBIGUOUS; ++v) {
            if (c.tally[v] >= QUORUM) verdict = v;
        }

        if (verdict == 0) {
            if (c.revealed < QUORUM) _lackedQuorum[id][round] = true;
            if (round < MAX_ROUNDS) {
                emit CourtRedrawn(id, round);
                _drawJury(id, m);
                return;
            }
            // The court failed: refund everyone. Only jurors whose absence broke quorum pay for it.
            _void(id, m);
            _releaseCreatorBond(id, m, false); // the court failed, not the question
            for (uint8 r = 1; r <= round; ++r) {
                if (_lackedQuorum[id][r]) _penalizeNoShows(id, r);
            }
            _push(m.proposer, BOND);
            _push(m.disputer, DISPUTE_BOND);
            return;
        }

        emit Verdict(id, round, verdict);
        _scoreJurors(id, round, verdict);
        if (verdict == VOTE_AMBIGUOUS) {
            _void(id, m);
            _releaseCreatorBond(id, m, true);
            _push(m.proposer, BOND);
            _push(m.disputer, DISPUTE_BOND);
        } else {
            bool outcome = verdict == VOTE_YES;
            _resolve(id, outcome);
            if (outcome == m.proposedOutcome) {
                // The dispute failed: the proposer is made whole and the disputer's bond pays the jury.
                _push(m.proposer, BOND);
                _payMajority(id, round, verdict, DISPUTE_BOND);
            } else {
                _push(m.disputer, DISPUTE_BOND + BOND);
            }
        }
    }

    function _scoreJurors(uint256 id, uint8 round, uint8 verdict) internal {
        address[] storage jury = _jury[id][round];
        for (uint256 i; i < jury.length; ++i) {
            address j = jury[i];
            uint8 vote = votes[id][round][j];
            if (vote == 0) continue; // quorum was met, so a no-show costs nothing
            Rep storage rep = _rep[j];
            if (vote == verdict) {
                rep.pending += JUROR_REWARD;
                rep.vestAt = uint64(block.timestamp + VEST_PERIOD);
                emit ReputationChanged(j, id, int256(JUROR_REWARD), rep.r, rep.pending, 0, false, false);
            } else {
                uint256 taken = _takeReputation(rep, JUROR_PENALTY);
                emit ReputationChanged(j, id, -int256(taken), rep.r, rep.pending, 0, false, false);
            }
        }
    }

    function _penalizeNoShows(uint256 id, uint8 round) internal {
        address[] storage jury = _jury[id][round];
        for (uint256 i; i < jury.length; ++i) {
            address j = jury[i];
            if (votes[id][round][j] != 0) continue;
            uint256 taken = _takeReputation(_rep[j], NO_SHOW_PENALTY);
            emit ReputationChanged(j, id, -int256(taken), _rep[j].r, _rep[j].pending, 0, false, false);
        }
    }

    function _payMajority(uint256 id, uint8 round, uint8 verdict, uint256 amount) internal {
        address[] storage jury = _jury[id][round];
        uint256 share = amount / _courts[id].tally[verdict];
        uint256 paid;
        for (uint256 i; i < jury.length; ++i) {
            if (votes[id][round][jury[i]] != verdict) continue;
            _push(jury[i], share);
            paid += share;
        }
        globalBonusPool += amount - paid; // rounding dust funds future markets
    }

    // ─── Settlement, phase 1: principal and reputation. Anyone can call it for anyone. ─
    function settle(uint256 id, address[] calldata users) external {
        Market storage m = _markets[id];
        if (m.state != State.Resolved) revert BadState();
        for (uint256 i; i < users.length; ++i) {
            _settle(id, m, users[i]);
        }
        Payouts storage pay = payouts[id];
        if (!pay.bonusOpen && pay.settledCount == _bettors[id].length) _openBonus(id, pay);
    }

    function _settle(uint256 id, Market storage m, address user) internal {
        if (settled[id][user] || !hasBet[id][user]) return;
        settled[id][user] = true;
        payouts[id].settledCount++;

        if (m.voided) {
            // AMBIGUOUS: everyone gets their money back and nobody's reputation moves.
            uint256 refund = positions[id][user][true].money + positions[id][user][false].money;
            _push(user, refund);
            emit Settled(id, user, refund, 0);
            return;
        }

        bool outcome = m.outcome;
        Position storage win = positions[id][user][outcome];
        Position storage lose = positions[id][user][!outcome];

        uint256 winMoney = outcome ? m.yesMoney : m.noMoney;
        uint256 losingMoney = outcome ? m.noMoney : m.yesMoney;

        uint256 payout;
        if (winMoney == 0) {
            payout = win.money + lose.money; // nobody picked the winner: refund
        } else if (win.money > 0) {
            uint256 distributable =
                losingMoney - (losingMoney * FEE_BPS) / 10_000 - (losingMoney * PROTOCOL_FEE_BPS) / 10_000;
            payout = win.money + (win.money * distributable) / winMoney;
        }

        uint256 weight;
        if (_countsForReputation(id, m)) {
            Rep storage rep = _rep[user];
            uint256 mult = multiplierOf(user); // before this market's update
            bool firstBets = rep.resolvedBets < N_MIN;
            if (win.money > 0) {
                uint256 gain = _applyGain(user, id, rep, win, outcome);
                weight = (gain * mult) / WAD;
                if (firstBets && !rep.flagged && win.money >= FLAG_SIZE && win.priceSum / win.money <= FLAG_PRICE) {
                    rep.flagged = true;
                    emit Flagged(user, id);
                }
            }
            if (lose.money > 0) _applyLoss(user, id, rep, lose, !outcome, outcome);
            rep.resolvedBets++;
        }

        if (weight > 0) {
            bonusWeight[id][user] = weight;
            payouts[id].totalWeight += weight;
        }
        if (payout > 0) _push(user, payout);
        emit Settled(id, user, payout, weight);
    }

    /// @dev Shallow markets can't move reputation, so it can't be farmed against your own wallets.
    function _countsForReputation(uint256 id, Market storage m) internal view returns (bool) {
        return m.yesMoney + m.noMoney >= MIN_REP_POOL && _bettors[id].length >= MIN_BETTORS;
    }

    function _stakeFactor(uint256 money) internal pure returns (uint256 s) {
        s = (money * WAD) / STAKE_REF;
        if (s > WAD) s = WAD;
    }

    function _applyGain(address user, uint256 id, Rep storage rep, Position storage pos, bool outcome)
        internal
        returns (uint256 gain)
    {
        uint256 p = pos.priceSum / pos.money;
        gain = (((K * _stakeFactor(pos.money)) / WAD) * (WAD - p)) / WAD;
        if (gain > DELTA_R_MAX) gain = DELTA_R_MAX;
        // Gains wait VEST_PERIOD; a new gain restarts the clock for everything pending.
        rep.pending += gain;
        rep.vestAt = uint64(block.timestamp + VEST_PERIOD);
        emit ReputationChanged(user, id, int256(gain), rep.r, rep.pending, p, outcome, outcome);
    }

    function _applyLoss(address user, uint256 id, Rep storage rep, Position storage pos, bool side, bool outcome)
        internal
    {
        uint256 p = pos.priceSum / pos.money;
        uint256 loss = (((LAMBDA * ((K * _stakeFactor(pos.money)) / WAD)) / WAD) * p) / WAD;
        uint256 taken = _takeReputation(rep, loss);
        emit ReputationChanged(user, id, -int256(taken), rep.r, rep.pending, p, side, outcome);
    }

    /// @dev Losses apply immediately: vested R first, then pending gains, so banking gains
    ///      while R sits at its floor of 0 doesn't dodge losses.
    function _takeReputation(Rep storage rep, uint256 amount) internal returns (uint256 taken) {
        uint256 fromR = amount > rep.r ? rep.r : amount;
        rep.r -= fromR;
        uint256 rest = amount - fromR;
        uint256 fromPending = rest > rep.pending ? rep.pending : rest;
        rep.pending -= fromPending;
        taken = fromR + fromPending;
    }

    // ─── Settlement, phase 2: bonus ─────────────────────────────────────────────
    function _openBonus(uint256 id, Payouts storage pay) internal {
        pay.bonusOpen = true;
        if (pay.totalWeight == 0 && pay.bonusPool > 0) {
            // Nobody earned positive reputation here: the bonus funds future markets.
            globalBonusPool += pay.bonusPool;
            emit BonusRolledOver(id, pay.bonusPool);
            pay.bonusPool = 0;
        }
        emit BonusOpened(id, pay.bonusPool, pay.totalWeight);
    }

    function bonusOf(uint256 id, address user) public view returns (uint256) {
        Payouts storage pay = payouts[id];
        if (pay.totalWeight == 0) return 0;
        return (pay.bonusPool * bonusWeight[id][user]) / pay.totalWeight;
    }

    /// @notice Pays a winner's bonus once every bettor has been settled. Anyone can call it.
    function claimBonus(uint256 id, address user) external {
        if (!payouts[id].bonusOpen) revert BonusNotOpen();
        if (bonusClaimed[id][user]) revert AlreadyClaimed();
        bonusClaimed[id][user] = true;
        uint256 amount = bonusOf(id, user);
        if (amount > 0) _push(user, amount);
        emit BonusClaimed(id, user, amount);
    }

    // ─── Vesting ───────────────────────────────────────────────────────────────
    /// @notice Moves pending gains into R once the vesting period has passed. Anyone can call it.
    function vest(address user) external {
        Rep storage rep = _rep[user];
        if (rep.pending == 0) revert NothingToVest();
        if (block.timestamp < rep.vestAt) revert StillVesting();
        if (rep.flagged) revert UnderReview();
        uint256 amount = rep.pending;
        rep.pending = 0;
        rep.r += amount;
        emit Vested(user, amount, rep.r);
    }

    // ─── Views ─────────────────────────────────────────────────────────────────
    function getMarket(uint256 id) external view returns (Market memory) {
        return _markets[id];
    }

    function getBettors(uint256 id) external view returns (address[] memory) {
        return _bettors[id];
    }

    function getCourt(uint256 id) external view returns (Court memory) {
        return _courts[id];
    }

    function getJury(uint256 id, uint8 round) external view returns (address[] memory) {
        return _jury[id][round];
    }

    function jurorPool() external view returns (address[] memory) {
        return _jurorPool;
    }

    // ─── Internals ─────────────────────────────────────────────────────────────
    function _addCategory(uint8 id, string memory name) internal {
        if (id == 0 || bytes(name).length == 0) revert BadCategory();
        categoryName[id] = name;
        emit CategoryAdded(id, name);
    }

    function _pull(address from, uint256 amount) internal {
        if (!usd.transferFrom(from, address(this), amount)) revert TransferFailed();
    }

    function _push(address to, uint256 amount) internal {
        if (!usd.transfer(to, amount)) revert TransferFailed();
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
