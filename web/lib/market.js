// Pure market logic, mirroring SqueekBet.sol so the UI shows exactly what the contract will do.
// No DOM, no network: everything here is unit-tested (test-web/market.test.mjs).

export const GENESIS = 1793022600; // SqueekCore genesis timestamp
export const ROUND = 600; // seconds per round
export const TIMEOUT = 86400; // SqueekBet.RESOLVE_TIMEOUT
export const MIN_BET = 10n ** 18n; // SqueekBet.MIN_BET (1 SQK)
export const STATUS = Object.freeze({ OPEN: 0, RESOLVED: 1, REFUNDING: 2 });
export const TABS = Object.freeze(["all", "open", "live", "settled", "refunding", "mine"]);

export const roundNow = (t) => (t < GENESIS ? 0 : Math.floor((t - GENESIS) / ROUND) + 1);
export const roundStartTs = (r) => GENESIS + (Number(r) - 1) * ROUND;

/**
 * Lifecycle of a market at time `t` given SqueekCore's settled round.
 * phase: open | live | settling | resolvable | stalled | resolved | refunding
 * tab:   the filter tab the market belongs to
 */
export function phaseOf(m, settled, t) {
  const start = roundStartTs(m.startRound), end = roundStartTs(m.endRound + 1n);
  const at = (phase, tab) => ({ phase, tab, start, end });
  if (m.status === STATUS.RESOLVED) return at("resolved", "settled");
  if (m.status === STATUS.REFUNDING) return at("refunding", "refunding");
  if (t < start) return at("open", "open"); // contract: bet() reverts once startRound begins
  if (settled >= m.endRound) return at("resolvable", "live"); // contract: resolve() needs settledThroughRound >= endRound
  if (t >= end + TIMEOUT) return at("stalled", "live"); // contract: triggerRefund() after end + 24h
  if (t < end) return at("live", "live");
  return at("settling", "live");
}

/**
 * What a new bet of `amount` on `yes` would pay if that side wins, with the pools as they are now.
 * Same formula as SqueekBet.claimable(): stake * totalPool / winningPool, rounded down.
 * If nobody is on the other side, the market would refund, so the bet is worth its stake.
 */
export function payoutIfWins(m, yes, amount) {
  if (amount <= 0n) return 0n;
  const mine = (yes ? m.yesPool : m.noPool) + amount;
  const other = yes ? m.noPool : m.yesPool;
  if (other === 0n) return amount;
  return (amount * (mine + other)) / mine;
}

/** Current pool multiplier for a side (total / side pool), or null when that side is empty. */
export function multiplier(m, yes) {
  const pool = yes ? m.yesPool : m.noPool;
  if (pool === 0n) return null;
  return Number(((m.yesPool + m.noPool) * 10000n) / pool) / 10000;
}

/**
 * Progress of a started market from settled onchain data.
 * mined: blocks mined in the settled part of the window (blocksBetween), null if nothing settled yet.
 * Blocks only accumulate, so once mined >= minBlocks the result is YES whatever happens next.
 */
export function progressOf(m, mined, settled, ratePerRound) {
  const total = Number(m.endRound - m.startRound) + 1;
  const done = Math.max(0, Math.min(total, Number(settled) - Number(m.startRound) + 1));
  const got = mined === null || mined === undefined ? 0 : Number(mined);
  const target = Number(m.minBlocks);
  const secured = got >= target;
  const projected = ratePerRound === null || ratePerRound === undefined || done >= total
    ? null : Math.round(got + ratePerRound * (total - done));
  const leader = secured ? "yes" : done >= total ? "no" : projected === null ? null : projected >= target ? "yes" : "no";
  return { total, done, mined: got, target, secured, projected, leader, pct: Math.min(100, (got / target) * 100) };
}

/**
 * A wallet's position in one market, or null if it never bet.
 * state: active (market still open) | claimable | claimed | lost
 */
export function positionOf(m, me) {
  if (!me) return null;
  const staked = me.yes + me.no;
  if (staked === 0n) return null;
  let state;
  if (me.claimed) state = "claimed";
  else if (me.claimable > 0n) state = "claimable";
  else if (m.status === STATUS.OPEN) state = "active";
  else state = "lost";
  return { staked, yes: me.yes, no: me.no, claimable: me.claimable, state };
}

export function summarize(positions) {
  const s = { active: 0, activeStake: 0n, claimableCount: 0, claimableTotal: 0n };
  for (const p of positions) {
    if (!p) continue;
    if (p.state === "active") { s.active++; s.activeStake += p.staked; }
    if (p.state === "claimable") { s.claimableCount++; s.claimableTotal += p.claimable; }
  }
  return s;
}
