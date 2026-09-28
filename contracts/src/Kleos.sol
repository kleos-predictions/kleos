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
///   Payout         m + (m / ΣwinningMoney) · (L − fee)       fee = FEE_BPS of the losing pool L
///   Bonus          bonusPool · w / Σw,  w = ΔR⁺ · M          (winners with positive ΔR)
///   Reputation     right: ΔR = +k·s·(1 − p)   wrong: ΔR = −λ·k·s·p
///                  p = rep-weighted price of the chosen side at entry, s = min(m / $50, 1)
///
/// Safeguards: activation after N_MIN resolved bets, vesting of gains, per-market gain cap,
/// minimum market depth, anomaly flag, resolver gating, category allowlist.
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
    uint256 public constant BOND = 10e6; // resolution bond
    uint256 public constant FEE_BPS = 200; // 2% of the losing pool funds the market's bonus
    uint256 public constant DELTA_R_MAX = 0.8e18; // max reputation gain from a single market (blunts long-shot windfalls)
    uint256 public constant MIN_REP_POOL = 1_000e6; // reputation only moves in markets this deep…
    uint256 public constant MIN_BETTORS = 10; // …with at least this many distinct bettors
    uint256 public constant FLAG_PRICE = 0.1e18; // long-shot threshold for the anomaly flag
    uint256 public constant FLAG_SIZE = 100e6; // size threshold for the anomaly flag
    uint256 public constant RESOLVER_MIN_R = 4e18; // tier II to propose or dispute

    uint256 public immutable DISPUTE_WINDOW;
    uint256 public immutable VEST_PERIOD;
    uint256 public immutable N_MIN; // resolved bets before reputation boosts anything

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
        bool proposedOutcome;
        uint64 proposedAt;
        address proposer;
        address disputer;
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

    // ─── Events ────────────────────────────────────────────────────────────────
    event CategoryAdded(uint8 indexed id, string name);
    event MarketCreated(uint256 indexed marketId, string question, uint8 category, string oracle, string criteria, uint64 closeTime);
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
    event OutcomeProposed(uint256 indexed marketId, address indexed proposer, bool outcome, bytes32 evidenceHash, string evidenceURI);
    event OutcomeDisputed(uint256 indexed marketId, address indexed disputer);
    event MarketResolved(uint256 indexed marketId, bool outcome, uint256 fee);
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

    constructor(IERC20 usd_, uint256 disputeWindow, uint256 vestPeriod, uint256 nMin) {
        usd = usd_;
        owner = msg.sender;
        DISPUTE_WINDOW = disputeWindow;
        VEST_PERIOD = vestPeriod;
        N_MIN = nMin;
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
    ) external onlyOwner returns (uint256 id) {
        if (bytes(categoryName[category]).length == 0) revert BadCategory();
        id = ++marketCount;
        Market storage m = _markets[id];
        m.question = question;
        m.category = category;
        m.oracle = oracle;
        m.criteria = criteria;
        m.closeTime = closeTime;
        emit MarketCreated(id, question, category, oracle, criteria, closeTime);
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
        Market storage m = _markets[id];
        if (m.state != State.Open || block.timestamp >= m.closeTime) revert MarketClosed();
        if (amount < MIN_BET) revert BetTooSmall();
        _pull(msg.sender, amount);

        (uint256 repYes,) = prices(id);
        uint256 entryPrice = yes ? repYes : WAD - repYes;
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

    // ─── Resolution: propose → dispute window → finalize (or owner arbitrates) ──
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

    function dispute(uint256 id) external {
        Market storage m = _markets[id];
        if (m.state != State.Proposed) revert BadState();
        if (block.timestamp >= m.proposedAt + DISPUTE_WINDOW) revert WindowClosed();
        _requireResolver(id);
        _pull(msg.sender, BOND);
        m.state = State.Disputed;
        m.disputer = msg.sender;
        emit OutcomeDisputed(id, msg.sender);
    }

    function finalize(uint256 id) external {
        Market storage m = _markets[id];
        if (m.state != State.Proposed) revert BadState();
        if (block.timestamp < m.proposedAt + DISPUTE_WINDOW) revert WindowOpen();
        _resolve(id, m.proposedOutcome);
        _push(m.proposer, BOND);
    }

    /// @notice Settles a disputed market. Whoever was right takes both bonds.
    function arbitrate(uint256 id, bool outcome) external onlyOwner {
        Market storage m = _markets[id];
        if (m.state != State.Disputed) revert BadState();
        _resolve(id, outcome);
        _push(outcome == m.proposedOutcome ? m.proposer : m.disputer, 2 * BOND);
    }

    /// @dev Resolvers need earned reputation and no stake in the market they judge.
    function _requireResolver(uint256 id) internal view {
        Rep storage rep = _rep[msg.sender];
        if (hasBet[id][msg.sender] || rep.flagged || rep.r < RESOLVER_MIN_R) revert NotEligibleResolver();
    }

    function _resolve(uint256 id, bool outcome) internal {
        Market storage m = _markets[id];
        m.state = State.Resolved;
        m.outcome = outcome;
        uint256 winMoney = outcome ? m.yesMoney : m.noMoney;
        uint256 losingMoney = outcome ? m.noMoney : m.yesMoney;
        // No fee when nobody picked the winner: everyone is refunded in full.
        uint256 fee = winMoney == 0 ? 0 : (losingMoney * FEE_BPS) / 10_000;
        payouts[id].bonusPool += fee;
        emit MarketResolved(id, outcome, fee);
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

        bool outcome = m.outcome;
        Position storage win = positions[id][user][outcome];
        Position storage lose = positions[id][user][!outcome];

        uint256 winMoney = outcome ? m.yesMoney : m.noMoney;
        uint256 losingMoney = outcome ? m.noMoney : m.yesMoney;

        uint256 payout;
        if (winMoney == 0) {
            payout = win.money + lose.money; // nobody picked the winner: refund
        } else if (win.money > 0) {
            uint256 distributable = losingMoney - (losingMoney * FEE_BPS) / 10_000;
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
