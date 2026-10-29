// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface ISqueekCore {
    struct CoreState {
        uint64 settledThroughRound;
        uint64 cumulativeWork;
        uint96 cumulativeBlockUnits;
        uint64 blockHeight;
        uint96 blockProgress;
        uint32 workPerThousandBlocks;
        uint256 authorizationNonce;
        bool paused;
    }
    struct LedgerPosition { uint64 cumulativeWork; uint96 cumulativeBlockUnits; uint32 workPerThousandBlocks; }
    struct RoundCheckpoint { uint64 roundId; uint64 cumulativeWork; uint96 cumulativeBlockUnits; uint32 workPerThousandBlocks; bytes32 dataHash; }
    struct RoundPage { uint64 certifiedThroughRound; LedgerPosition start; LedgerPosition end; RoundCheckpoint[] rounds; }
    struct CoreConfiguration {
        bytes32 streamId;
        uint64 genesisTimestamp;
        uint64 roundDuration;
        uint64 maxWorkPerRound;
        uint16 maxRoundsPerBatch;
        address guardian;
        address reporter;
        uint32 initialWorkPerThousandBlocks;
        uint64 targetBlocksPerActiveRound;
        uint64 difficultySmoothingRounds;
        uint96 blockUnitsPerBlock;
    }

    function state() external view returns (CoreState memory);
    function roundPage(uint64 afterRound, uint64 throughRound, uint256 maxRecords) external view returns (RoundPage memory);
    function configuration() external view returns (CoreConfiguration memory);
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title SqueekBet
/// @notice Parimutuel prediction markets on the hamster's output, resolved
///         without an oracle from SqueekCore's settled (certified) ledger.
///         Question: "will at least `minBlocks` Squeek blocks be mined during
///         rounds [startRound, endRound]?" Betting closes when startRound begins.
///         Stakes are in SQK, the Squeekchain token.
///         Only `marketCreator` (the deployer) can open markets. That role has no
///         other power: it cannot move funds, cancel markets or influence results.
contract SqueekBet {
    enum Status { Open, Resolved, Refunding }

    struct Market {
        uint64 startRound;
        uint64 endRound;
        uint64 minBlocks;
        uint64 blocksMined;
        Status status;
        bool yesWon;
        address creator;
        uint256 yesPool;
        uint256 noPool;
    }

    uint256 public constant RESOLVE_TIMEOUT = 24 hours;
    uint64 public constant MAX_SPAN_ROUNDS = 1008; // about one week
    uint64 public constant MAX_LEAD_ROUNDS = 4320; // markets start within 30 days
    uint256 private constant RESOLVE_CHECK_GAS = 500_000;
    uint256 public constant MIN_BET = 1e18; // 1 SQK

    ISqueekCore public immutable core;
    IERC20 public immutable token;
    address public immutable marketCreator;
    uint64 public immutable genesis;
    uint64 public immutable roundDuration;
    uint96 public immutable unitsPerBlock;

    Market[] private _markets;
    mapping(uint256 => mapping(address => uint256)) public yesStake;
    mapping(uint256 => mapping(address => uint256)) public noStake;
    mapping(uint256 => mapping(address => bool)) public claimed;
    uint256 private _lock = 1;

    event MarketCreated(uint256 indexed id, address indexed creator, uint64 startRound, uint64 endRound, uint64 minBlocks);
    event BetPlaced(uint256 indexed id, address indexed user, bool yes, uint256 amount);
    event MarketResolved(uint256 indexed id, bool yesWon, uint64 blocksMined, bool refunding);
    event MarketRefunding(uint256 indexed id);
    event Claimed(uint256 indexed id, address indexed user, uint256 amount);

    error StartNotInFuture();
    error BadSpan();
    error BadThreshold();
    error UnknownMarket();
    error NotOpen();
    error BettingClosed();
    error BetTooSmall();
    error NotSettled();
    error TimeoutNotReached();
    error NothingToClaim();
    error AlreadyClaimed();
    error TransferFailed();
    error UseResolve();
    error NotMarketCreator();
    error Reentrancy();
    error NotEnoughGas();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(ISqueekCore core_, IERC20 token_) {
        ISqueekCore.CoreConfiguration memory cfg = core_.configuration();
        core = core_;
        token = token_;
        marketCreator = msg.sender;
        genesis = cfg.genesisTimestamp;
        roundDuration = cfg.roundDuration;
        unitsPerBlock = cfg.blockUnitsPerBlock;
    }

    // ---------- views ----------

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function getMarket(uint256 id) public view returns (Market memory) {
        if (id >= _markets.length) revert UnknownMarket();
        return _markets[id];
    }

    function currentRound() public view returns (uint64) {
        if (block.timestamp < genesis) return 0;
        return uint64((block.timestamp - genesis) / roundDuration + 1);
    }

    /// @notice Unix time at which round `r` (r >= 1) starts.
    function roundStart(uint64 r) public view returns (uint256) {
        return uint256(genesis) + uint256(r - 1) * roundDuration;
    }

    /// @notice Squeek blocks completed during certified rounds [startRound, endRound].
    function blocksBetween(uint64 startRound, uint64 endRound) public view returns (uint64) {
        uint96 uStart = core.roundPage(startRound - 1, startRound - 1, 0).end.cumulativeBlockUnits;
        uint96 uEnd = core.roundPage(endRound, endRound, 0).end.cumulativeBlockUnits;
        return uint64(uEnd / unitsPerBlock - uStart / unitsPerBlock);
    }

    // ---------- actions ----------

    function createMarket(uint64 startRound, uint64 endRound, uint64 minBlocks) external returns (uint256 id) {
        if (msg.sender != marketCreator) revert NotMarketCreator();
        uint64 nowRound = currentRound();
        if (startRound <= nowRound) revert StartNotInFuture();
        if (startRound - nowRound > MAX_LEAD_ROUNDS) revert BadSpan();
        if (endRound < startRound || endRound - startRound >= MAX_SPAN_ROUNDS) revert BadSpan();
        if (minBlocks == 0) revert BadThreshold();
        id = _markets.length;
        _markets.push(Market({
            startRound: startRound,
            endRound: endRound,
            minBlocks: minBlocks,
            blocksMined: 0,
            status: Status.Open,
            yesWon: false,
            creator: msg.sender,
            yesPool: 0,
            noPool: 0
        }));
        emit MarketCreated(id, msg.sender, startRound, endRound, minBlocks);
    }

    function bet(uint256 id, bool yes, uint256 amount) external nonReentrant {
        Market storage m = _market(id);
        if (m.status != Status.Open) revert NotOpen();
        if (block.timestamp >= roundStart(m.startRound)) revert BettingClosed();
        if (amount < MIN_BET) revert BetTooSmall();
        if (yes) {
            m.yesPool += amount;
            yesStake[id][msg.sender] += amount;
        } else {
            m.noPool += amount;
            noStake[id][msg.sender] += amount;
        }
        _tokenCall(abi.encodeCall(IERC20.transferFrom, (msg.sender, address(this), amount)));
        emit BetPlaced(id, msg.sender, yes, amount);
    }

    /// @notice Anyone can resolve once every round of the market is certified onchain.
    function resolve(uint256 id) external {
        Market storage m = _market(id);
        if (m.status != Status.Open) revert NotOpen();
        if (core.state().settledThroughRound < m.endRound) revert NotSettled();

        uint64 mined = blocksBetween(m.startRound, m.endRound);
        m.blocksMined = mined;
        m.yesWon = mined >= m.minBlocks;
        // A one-sided market has no counterparty: everybody gets their stake back.
        bool refunding = m.yesPool == 0 || m.noPool == 0;
        m.status = refunding ? Status.Refunding : Status.Resolved;
        emit MarketResolved(id, m.yesWon, mined, refunding);
    }

    /// @notice Reverts unless the market's rounds are settled and readable. Used by triggerRefund.
    function checkResolvable(uint64 startRound, uint64 endRound) external view returns (bool) {
        if (core.state().settledThroughRound < endRound) revert NotSettled();
        blocksBetween(startRound, endRound);
        return true;
    }

    /// @notice Safety valve: if settlement stalls or SqueekCore becomes unreadable
    ///         (pause, broken upgrade...), unlock refunds so funds can never be stuck.
    ///         A market that can still be resolved must be resolved: nobody can dodge a result.
    function triggerRefund(uint256 id) external {
        Market storage m = _market(id);
        if (m.status != Status.Open) revert NotOpen();
        if (block.timestamp < roundStart(m.endRound + 1) + RESOLVE_TIMEOUT) revert TimeoutNotReached();
        // Forward a fixed gas budget so a caller cannot starve the check into failing on purpose.
        if (gasleft() < RESOLVE_CHECK_GAS * 64 / 63 + 20_000) revert NotEnoughGas();
        try this.checkResolvable{gas: RESOLVE_CHECK_GAS}(m.startRound, m.endRound) returns (bool) {
            revert UseResolve();
        } catch {}
        m.status = Status.Refunding;
        emit MarketRefunding(id);
    }

    function claimable(uint256 id, address user) public view returns (uint256) {
        Market memory m = getMarket(id);
        if (claimed[id][user]) return 0;
        if (m.status == Status.Refunding) return yesStake[id][user] + noStake[id][user];
        if (m.status == Status.Resolved) {
            uint256 total = m.yesPool + m.noPool;
            return m.yesWon
                ? yesStake[id][user] * total / m.yesPool
                : noStake[id][user] * total / m.noPool;
        }
        return 0;
    }

    function claim(uint256 id) external nonReentrant {
        if (claimed[id][msg.sender]) revert AlreadyClaimed();
        uint256 amount = claimable(id, msg.sender);
        if (amount == 0) revert NothingToClaim();
        claimed[id][msg.sender] = true;
        _tokenCall(abi.encodeCall(IERC20.transfer, (msg.sender, amount)));
        emit Claimed(id, msg.sender, amount);
    }

    /// @dev Accepts tokens that return true or nothing; reverts on false or failure.
    function _tokenCall(bytes memory data) private {
        (bool ok, bytes memory ret) = address(token).call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _market(uint256 id) private view returns (Market storage) {
        if (id >= _markets.length) revert UnknownMarket();
        return _markets[id];
    }
}
