// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SqueekBet, ISqueekCore, IERC20} from "../src/SqueekBet.sol";

/// Fake SqueekCore: per-round cumulative block units and a settled frontier.
contract MockCore {
    uint64 public settled;
    mapping(uint64 => uint96) public unitsAt;
    uint64 public genesis;
    bool public broken;

    constructor(uint64 g) { genesis = g; }

    function setBroken(bool b) external { broken = b; }

    function setSettled(uint64 r) external { settled = r; }
    function setUnits(uint64 r, uint96 u) external { unitsAt[r] = u; }

    function configuration() external view returns (ISqueekCore.CoreConfiguration memory c) {
        c.genesisTimestamp = genesis;
        c.roundDuration = 600;
        c.blockUnitsPerBlock = 1e9;
    }

    function state() external view returns (ISqueekCore.CoreState memory s) {
        require(!broken, "broken");
        s.settledThroughRound = settled;
    }

    function roundPage(uint64, uint64 throughRound, uint256) external view returns (ISqueekCore.RoundPage memory p) {
        require(!broken, "broken");
        require(throughRound <= settled, "InvalidRoundPageBounds");
        p.certifiedThroughRound = throughRound;
        p.end.cumulativeBlockUnits = unitsAt[throughRound];
    }
}

contract MockSQK {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

contract SqueekBetTest is Test {
    MockSQK sqk;
    MockCore core;
    SqueekBet bet;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    uint64 constant G = 1_000_000;

    function setUp() public {
        vm.warp(G + 600 * 9 + 1); // inside round 10
        core = new MockCore(G);
        sqk = new MockSQK();
        bet = new SqueekBet(ISqueekCore(address(core)), IERC20(address(sqk)));
        sqk.mint(alice, 10 ether);
        sqk.mint(bob, 10 ether);
        vm.prank(alice); sqk.approve(address(bet), type(uint256).max);
        vm.prank(bob); sqk.approve(address(bet), type(uint256).max);
    }

    function _market() internal returns (uint256) {
        // rounds 11..16, YES if >= 100 blocks
        return bet.createMarket(11, 16, 100);
    }

    function test_currentRound() public view {
        assertEq(bet.currentRound(), 10);
    }

    function test_cannotCreateStartedMarket() public {
        vm.expectRevert(SqueekBet.StartNotInFuture.selector);
        bet.createMarket(10, 12, 1);
    }

    function test_yesWinsPaysProRata() public {
        uint256 id = _market();
        vm.prank(alice); bet.bet(id, true, 1 ether);
        vm.prank(bob);   bet.bet(id, false, 3 ether);

        core.setUnits(10, 5_000 * 1e9 + 7);
        core.setUnits(16, 5_120 * 1e9);   // floor 5000 -> 5120: 120 blocks
        core.setSettled(16);
        vm.warp(G + 600 * 16 + 1);
        bet.resolve(id);

        SqueekBet.Market memory m = bet.getMarket(id);
        assertEq(uint8(m.status), uint8(SqueekBet.Status.Resolved));
        assertTrue(m.yesWon);
        assertEq(m.blocksMined, 120);

        uint256 before = sqk.balanceOf(alice);
        vm.prank(alice); bet.claim(id);
        assertEq(sqk.balanceOf(alice) - before, 4 ether);
        assertEq(bet.claimable(id, bob), 0);
        vm.prank(alice);
        vm.expectRevert(SqueekBet.AlreadyClaimed.selector);
        bet.claim(id);
    }

    function test_noWins() public {
        uint256 id = _market();
        vm.prank(alice); bet.bet(id, true, 1 ether);
        vm.prank(bob);   bet.bet(id, false, 1 ether);
        core.setUnits(10, 0);
        core.setUnits(16, 99 * 1e9);
        core.setSettled(20);
        bet.resolve(id);
        assertFalse(bet.getMarket(id).yesWon);
        uint256 before = sqk.balanceOf(bob);
        vm.prank(bob); bet.claim(id);
        assertEq(sqk.balanceOf(bob) - before, 2 ether);
    }

    function test_bettingClosesAtStart() public {
        uint256 id = _market();
        vm.warp(G + 600 * 10); // round 11 starts
        vm.prank(alice);
        vm.expectRevert(SqueekBet.BettingClosed.selector);
        bet.bet(id, true, 1 ether);
    }

    function test_cannotDodgeResultWithRefund() public {
        uint256 id = _market();
        vm.prank(alice); bet.bet(id, true, 1 ether);
        vm.prank(bob);   bet.bet(id, false, 1 ether);
        core.setUnits(16, 500 * 1e9);
        core.setSettled(16);
        vm.warp(G + 600 * 16 + 24 hours);
        vm.expectRevert(SqueekBet.UseResolve.selector);
        bet.triggerRefund(id);
        bet.resolve(id);
        assertTrue(bet.getMarket(id).yesWon);
    }

    function test_brokenCoreUnlocksRefund() public {
        uint256 id = _market();
        vm.prank(alice); bet.bet(id, true, 1 ether);
        vm.prank(bob);   bet.bet(id, false, 3 ether);
        core.setSettled(16);
        core.setBroken(true);
        vm.expectRevert();
        bet.resolve(id);
        vm.warp(G + 600 * 16 + 24 hours);
        bet.triggerRefund(id);
        uint256 before = sqk.balanceOf(bob);
        vm.prank(bob); bet.claim(id);
        assertEq(sqk.balanceOf(bob) - before, 3 ether);
    }

    function test_refundCannotBeGasGriefed() public {
        uint256 id = _market();
        vm.prank(alice); bet.bet(id, true, 1 ether);
        vm.prank(bob);   bet.bet(id, false, 1 ether);
        core.setUnits(16, 500 * 1e9);
        core.setSettled(16);
        vm.warp(G + 600 * 16 + 24 hours);
        // With too little gas the call reverts instead of silently refunding.
        (bool ok,) = address(bet).call{gas: 300_000}(abi.encodeCall(SqueekBet.triggerRefund, (id)));
        assertFalse(ok);
        assertEq(uint8(bet.getMarket(id).status), uint8(SqueekBet.Status.Open));
    }

    function test_cannotCreateFarFutureMarket() public {
        vm.expectRevert(SqueekBet.BadSpan.selector);
        bet.createMarket(10 + 4321, 10 + 4322, 1);
    }

    function test_solvencyManyBettors() public {
        uint256 id = _market();
        for (uint160 i = 1; i <= 20; i++) {
            address u = address(i * 7919);
            sqk.mint(u, 1000 ether);
            vm.startPrank(u);
            sqk.approve(address(bet), type(uint256).max);
            bet.bet(id, i % 3 != 0, (uint256(i) * 1.37 ether) + 1);
            vm.stopPrank();
        }
        core.setUnits(16, 500 * 1e9);
        core.setSettled(16);
        bet.resolve(id);
        for (uint160 i = 1; i <= 20; i++) {
            address u = address(i * 7919);
            if (bet.claimable(id, u) > 0) { vm.prank(u); bet.claim(id); }
        }
        // only rounding dust can remain, never a shortfall
        assertLt(sqk.balanceOf(address(bet)), 20);
    }

    function testFuzz_payoutsNeverExceedPool(uint96 a, uint96 b, uint96 c, bool yesWins) public {
        uint256 id = _market();
        address carol = address(0xCA201);
        uint256 x = bound(uint256(a), 1e18, 1e30);
        uint256 y = bound(uint256(b), 1e18, 1e30);
        uint256 z = bound(uint256(c), 1e18, 1e30);
        sqk.mint(alice, x); sqk.mint(bob, y); sqk.mint(carol, z);
        vm.prank(carol); sqk.approve(address(bet), type(uint256).max);
        vm.prank(alice); bet.bet(id, true, x);
        vm.prank(bob);   bet.bet(id, false, y);
        vm.prank(carol); bet.bet(id, yesWins, z);
        core.setUnits(16, yesWins ? 500 * 1e9 : 0);
        core.setSettled(16);
        bet.resolve(id);
        uint256 total = x + y + z;
        uint256 paid = bet.claimable(id, alice) + bet.claimable(id, bob) + bet.claimable(id, carol);
        assertLe(paid, total);
        assertGe(paid + 3, total); // at most 1 wei of dust per winner
    }

    function test_onlyCreatorCanCreateMarkets() public {
        assertEq(bet.marketCreator(), address(this));
        vm.prank(alice);
        vm.expectRevert(SqueekBet.NotMarketCreator.selector);
        bet.createMarket(11, 16, 100);
        bet.createMarket(11, 16, 100);
        assertEq(bet.marketCount(), 1);
    }

    function test_creatorHasNoPowerOverFunds() public {
        uint256 id = _market();
        vm.prank(alice); bet.bet(id, true, 1 ether);
        vm.prank(bob);   bet.bet(id, false, 1 ether);
        // the creator has no stake, so it cannot claim anything, and there is no withdraw function
        vm.expectRevert(SqueekBet.NothingToClaim.selector);
        bet.claim(id);
        core.setUnits(16, 500 * 1e9);
        core.setSettled(16);
        bet.resolve(id);
        vm.expectRevert(SqueekBet.NothingToClaim.selector);
        bet.claim(id);
        assertEq(sqk.balanceOf(address(bet)), 2 ether);
    }

    function test_betTooSmall() public {
        uint256 id = _market();
        vm.prank(alice);
        vm.expectRevert(SqueekBet.BetTooSmall.selector);
        bet.bet(id, true, 1e18 - 1);
    }

    function test_poolHoldsTokens() public {
        uint256 id = _market();
        vm.prank(alice); bet.bet(id, true, 2 ether);
        assertEq(sqk.balanceOf(address(bet)), 2 ether);
        assertEq(sqk.balanceOf(alice), 8 ether);
    }

    function test_cannotResolveBeforeSettled() public {
        uint256 id = _market();
        core.setSettled(15);
        vm.expectRevert(SqueekBet.NotSettled.selector);
        bet.resolve(id);
    }

    function test_oneSidedMarketRefunds() public {
        uint256 id = _market();
        vm.prank(alice); bet.bet(id, true, 1 ether);
        core.setUnits(16, 500 * 1e9);
        core.setSettled(16);
        bet.resolve(id);
        assertEq(uint8(bet.getMarket(id).status), uint8(SqueekBet.Status.Refunding));
        uint256 before = sqk.balanceOf(alice);
        vm.prank(alice); bet.claim(id);
        assertEq(sqk.balanceOf(alice) - before, 1 ether);
    }

    function test_timeoutRefund() public {
        uint256 id = _market();
        vm.prank(alice); bet.bet(id, true, 1 ether);
        vm.prank(bob);   bet.bet(id, false, 2 ether);
        vm.warp(G + 600 * 16 + 24 hours - 1);
        vm.expectRevert(SqueekBet.TimeoutNotReached.selector);
        bet.triggerRefund(id);
        vm.warp(G + 600 * 16 + 24 hours);
        bet.triggerRefund(id);
        uint256 before = sqk.balanceOf(bob);
        vm.prank(bob); bet.claim(id);
        assertEq(sqk.balanceOf(bob) - before, 2 ether);
    }
}

/// Reads the real SqueekCore on a Sepolia fork to prove the interface decodes.
contract SqueekBetForkTest is Test {
    function test_fork_realCore() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        ISqueekCore core = ISqueekCore(0x980B4424c007CAf7a1f3670B48c8EaEf7EbC3d44);
        IERC20 token = IERC20(0x6872BfA5CcC3E9e440C6c16e5fFdAbb8DBA4Cc76);
        SqueekBet b = new SqueekBet(core, token);
        (, bytes memory sym) = address(token).staticcall(abi.encodeWithSignature("symbol()"));
        (, bytes memory dec) = address(token).staticcall(abi.encodeWithSignature("decimals()"));
        emit log_named_string("token symbol", abi.decode(sym, (string)));
        assertEq(abi.decode(dec, (uint8)), 18);
        assertEq(b.genesis(), 1793022600);
        assertEq(b.roundDuration(), 600);
        assertEq(b.unitsPerBlock(), 1e9);

        ISqueekCore.CoreState memory s = core.state();
        uint64 all = b.blocksBetween(1, s.settledThroughRound);
        assertEq(all, s.blockHeight);
        emit log_named_uint("settledThroughRound", s.settledThroughRound);
        emit log_named_uint("blockHeight", s.blockHeight);
        emit log_named_uint("blocks last 144 rounds", b.blocksBetween(s.settledThroughRound > 143 ? s.settledThroughRound - 143 : 1, s.settledThroughRound));
    }
    function test_fork_betWithRealSQK() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        address sqkAddr = 0x6872BfA5CcC3E9e440C6c16e5fFdAbb8DBA4Cc76;
        SqueekBet b = new SqueekBet(ISqueekCore(0x980B4424c007CAf7a1f3670B48c8EaEf7EbC3d44), IERC20(sqkAddr));
        address user = address(0xBEEF);
        deal(sqkAddr, user, 50 ether);
        uint256 id = b.createMarket(b.currentRound() + 1, b.currentRound() + 6, 10);
        vm.startPrank(user);
        (bool ok,) = sqkAddr.call(abi.encodeWithSignature("approve(address,uint256)", address(b), 20 ether));
        assertTrue(ok);
        b.bet(id, true, 20 ether);
        vm.stopPrank();
        (, bytes memory bal) = sqkAddr.staticcall(abi.encodeWithSignature("balanceOf(address)", address(b)));
        assertEq(abi.decode(bal, (uint256)), 20 ether);
        assertEq(b.getMarket(id).yesPool, 20 ether);
    }
}

