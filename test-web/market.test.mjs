import test from "node:test";
import assert from "node:assert/strict";
import { phaseOf, payoutIfWins, multiplier, progressOf, positionOf, summarize, roundStartTs, roundNow, GENESIS, ROUND, TIMEOUT, STATUS } from "../stage/web/lib/market.js";
import { parseAmount, esc, fmtDur } from "../stage/web/lib/format.js";

const E = 10n ** 18n;
const mk = (o = {}) => ({ startRound: 100n, endRound: 105n, minBlocks: 10n, blocksMined: 0n, status: 0, yesWon: false, yesPool: 0n, noPool: 0n, ...o });
const start = roundStartTs(100), end = roundStartTs(106);

test("round clock", () => {
  assert.equal(roundNow(GENESIS - 1), 0);
  assert.equal(roundNow(GENESIS), 1);
  assert.equal(roundNow(GENESIS + ROUND), 2);
  assert.equal(roundStartTs(1), GENESIS);
});

test("phases follow the contract rules", () => {
  assert.equal(phaseOf(mk(), 0n, start - 1).phase, "open");
  assert.equal(phaseOf(mk(), 0n, start).phase, "live"); // betting closes exactly at start
  assert.equal(phaseOf(mk(), 104n, end).phase, "settling");
  assert.equal(phaseOf(mk(), 105n, end).phase, "resolvable");
  assert.equal(phaseOf(mk(), 104n, end + TIMEOUT - 1).phase, "settling");
  assert.equal(phaseOf(mk(), 104n, end + TIMEOUT).phase, "stalled");
  assert.equal(phaseOf(mk({ status: STATUS.RESOLVED }), 0n, 0).tab, "settled");
  assert.equal(phaseOf(mk({ status: STATUS.REFUNDING }), 0n, 0).tab, "refunding");
  assert.equal(phaseOf(mk(), 105n, end + TIMEOUT).phase, "resolvable"); // must resolve, cannot dodge into refund
});

test("payout matches SqueekBet.claimable()", () => {
  const m = mk({ yesPool: 300n * E, noPool: 100n * E });
  // bet 100 NO: no pool 200, total 500 -> 100 * 500 / 200 = 250
  assert.equal(payoutIfWins(m, false, 100n * E), 250n * E);
  // bet 100 YES: yes pool 400, total 500 -> 125
  assert.equal(payoutIfWins(m, true, 100n * E), 125n * E);
  // rounding down like Solidity
  assert.equal(payoutIfWins(mk({ yesPool: 1n, noPool: 1n }), true, 1n), 1n);
  // empty other side: refund value
  assert.equal(payoutIfWins(mk({ yesPool: 50n * E }), true, 10n * E), 10n * E);
  assert.equal(payoutIfWins(m, true, 0n), 0n);
});

test("multiplier", () => {
  const m = mk({ yesPool: 300n * E, noPool: 100n * E });
  assert.equal(multiplier(m, true), 1.3333);
  assert.equal(multiplier(m, false), 4);
  assert.equal(multiplier(mk(), true), null);
});

test("progress", () => {
  const p = progressOf(mk(), 4n, 102n, 2);
  assert.deepEqual([p.total, p.done, p.mined, p.secured, p.projected, p.leader], [6, 3, 4, false, 10, "yes"]);
  assert.equal(progressOf(mk(), 4n, 102n, 1).leader, "no");
  assert.equal(progressOf(mk(), 12n, 102n, 0).secured, true);
  assert.equal(progressOf(mk(), 12n, 102n, 0).pct, 100);
  assert.equal(progressOf(mk(), null, 90n, 1).done, 0);
  assert.equal(progressOf(mk(), 9n, 105n, 5).leader, "no"); // window fully settled below target
  assert.equal(progressOf(mk(), 9n, 105n, 5).projected, null);
});

test("positions and summary", () => {
  const me = (o) => ({ yes: 0n, no: 0n, claimable: 0n, claimed: false, ...o });
  assert.equal(positionOf(mk(), me({})), null);
  assert.equal(positionOf(mk(), null), null);
  assert.equal(positionOf(mk(), me({ yes: E })).state, "active");
  assert.equal(positionOf(mk({ status: 1 }), me({ yes: E, claimable: 2n * E })).state, "claimable");
  assert.equal(positionOf(mk({ status: 1 }), me({ yes: E, claimed: true })).state, "claimed");
  assert.equal(positionOf(mk({ status: 1 }), me({ no: E })).state, "lost");
  const s = summarize([positionOf(mk(), me({ yes: E })), positionOf(mk({ status: 2 }), me({ no: E, claimable: E })), null]);
  assert.deepEqual(s, { active: 1, activeStake: E, claimableCount: 1, claimableTotal: E });
});

test("amount parsing rejects anything but plain decimals", () => {
  assert.equal(parseAmount("100"), 100n * E);
  assert.equal(parseAmount(" 12.5 "), 125n * E / 10n);
  assert.equal(parseAmount("12,5"), 125n * E / 10n);
  for (const bad of ["", "-1", "1e3", "0x10", "1.0000000000000000001", "abc", "1 000", "Infinity", "1000000000000"]) assert.equal(parseAmount(bad), null, bad);
});

test("escaping and durations", () => {
  assert.equal(esc(`<img src=x onerror="a">'&`), "&lt;img src=x onerror=&quot;a&quot;&gt;&#39;&amp;");
  assert.equal(fmtDur(0), "0m");
  assert.equal(fmtDur(3660), "1h 1m");
});
