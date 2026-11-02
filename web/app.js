import { createPublicClient, createWalletClient, custom, http, parseAbi, keccak256, sepolia } from "./vendor/viem.js";
import { SQUEEKBET_ABI, SQUEEKBET_BYTECODE } from "./abi.js";
import { GENESIS, ROUND, MIN_BET, STATUS, TABS, roundNow, roundStartTs, phaseOf, payoutIfWins, multiplier, progressOf, positionOf, summarize } from "./lib/market.js";
import { now, esc, fmtTime, fmtDur, sqk, int, parseAmount } from "./lib/format.js";

// ---------- config ----------
const CORE = "0x980B4424c007CAf7a1f3670B48c8EaEf7EbC3d44";
const SQK = "0x6872BfA5CcC3E9e440C6c16e5fFdAbb8DBA4Cc76";
const API = "https://api.squeekchain.com/v1";
const CFG = window.SQUEEKBET || {};
const RPC = CFG.rpc || "https://ethereum-sepolia-rpc.publicnode.com";
const UNITS = 1000000000n;
const MAX_MARKETS = 200; // newest markets loaded (multicall keeps this to a few RPC requests)
const STORE_KEY = "squeekbet.v5.address", TAB_KEY = "squeekbet.tab";
const CORE_ABI = parseAbi([
  "function state() view returns ((uint64 settledThroughRound, uint64 cumulativeWork, uint96 cumulativeBlockUnits, uint64 blockHeight, uint96 blockProgress, uint32 workPerThousandBlocks, uint256 authorizationNonce, bool paused))",
  "function roundPage(uint64 afterRound, uint64 throughRound, uint256 maxRecords) view returns ((uint64 certifiedThroughRound, (uint64 cumulativeWork, uint96 cumulativeBlockUnits, uint32 workPerThousandBlocks) start, (uint64 cumulativeWork, uint96 cumulativeBlockUnits, uint32 workPerThousandBlocks) end, (uint64 roundId, uint64 cumulativeWork, uint96 cumulativeBlockUnits, uint32 workPerThousandBlocks, bytes32 dataHash)[] rounds))",
]);
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const ERRORS = {
  StartNotInFuture: "The start must be in the future.",
  BadSpan: "Invalid duration (1 week max).",
  BadThreshold: "Min blocks must be at least 1.",
  NotOpen: "This market is no longer open.",
  BettingClosed: "Betting is closed because the window has started.",
  BetTooSmall: "The minimum bet is 1 SQK.",
  NotSettled: "These rounds are not settled onchain yet.",
  TimeoutNotReached: "The refund timeout has not been reached yet.",
  UseResolve: "This market can be resolved, so it must be resolved instead of refunded.",
  NothingToClaim: "There is nothing to claim.",
  NotMarketCreator: "Only the SqueekBet market creator can open markets.",
  AlreadyClaimed: "You already claimed this market.",
  TransferFailed: "The SQK transfer failed. Check your balance and approval.",
};

// ---------- state ----------
const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
let wallet = null, account = null, creator = null, trusted = false, busy = false;
let settled = 0n, ratePerRound = null;
// The contract address only comes from config.js on this server (or this browser's own fresh deployment),
// never from the URL, so a shared link cannot point users at a fake contract.
let addr = CFG.address || store.get(STORE_KEY) || "";
const view = { markets: [], loaded: false, error: "", tab: TABS.includes(store.get(TAB_KEY)) ? store.get(TAB_KEY) : "all" };
const drafts = new Map(); // bet amounts being typed, kept across re-renders

function toast(msg, ms = 4000) {
  const t = $("toast"); t.textContent = msg; t.style.display = "block";
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.style.display = "none"), ms);
}
function errMsg(e) {
  const s = (e && (e.shortMessage || e.message)) || String(e);
  for (const k in ERRORS) if (s.includes(k)) return ERRORS[k];
  if (/User rejected|denied/i.test(s)) return "You rejected the transaction.";
  return s.split("\n")[0].slice(0, 200);
}

// ---------- live data ----------
async function loadLive() {
  try {
    const s = await (await fetch(API + "/status")).json();
    const m = s.measurement || {};
    const online = m.freshness === "online";
    const running = online && m.coreStatus && m.coreStatus !== "IDLE";
    $("wheel").textContent = !online ? "wheel sensor offline" : running ? "is running" : "is sleeping";
    $("wheel").className = "dm l-status " + (running ? "cream" : "dim");
    $("rpm").textContent = running ? `${Math.round((m.rpmMilli || 0) / 1000)} RPM` : "";
    const q = s.settlementQueue || {};
    const w = $("settleWarn");
    if (q.settlementEnabled === false || q.incidentOpen) {
      w.textContent = "⚠️ Squeekchain onchain settlement is paused right now. Markets will resolve when it resumes. If settlement stays stalled for 24 hours, refunds unlock.";
      w.classList.remove("hidden");
    } else w.classList.add("hidden");
  } catch { $("wheel").textContent = "no signal"; }
  $("round").textContent = int(roundNow(now()));
}

async function loadChain() {
  const st = await pub.readContract({ address: CORE, abi: CORE_ABI, functionName: "state" });
  settled = st.settledThroughRound;
  $("height").textContent = int(st.blockHeight);
  $("settled").textContent = int(settled);
  // pace over the last 24h of settled rounds (or since genesis on a young chain)
  if (settled >= 2n) {
    const span = settled > 144n ? 144n : settled - 1n;
    const pt = (r) => pub.readContract({ address: CORE, abi: CORE_ABI, functionName: "roundPage", args: [r, r, 0n] });
    const [a, b] = await Promise.all([pt(settled - span), pt(settled)]);
    const first = ratePerRound === null;
    ratePerRound = Number(b.end.cumulativeBlockUnits - a.end.cumulativeBlockUnits) / Number(UNITS) / Number(span);
    $("rate").textContent = `${Math.round(ratePerRound * 6)}/H`;
    if (first) suggestLine();
  }
}

// ---------- contract check ----------
async function verifyContract() {
  const fail = (why) => {
    trusted = false;
    $("fakeWarn").textContent = `⛔ This is not the official SqueekBet contract (${why}). Do not bet. Betting is disabled.`;
    $("fakeWarn").classList.remove("hidden");
    $("verified").textContent = "";
  };
  try {
    const code = await pub.getCode({ address: addr });
    if (!code || code === "0x") return fail("no contract at this address");
    if (CFG.codeHash && keccak256(code).toLowerCase() !== CFG.codeHash.toLowerCase()) return fail("unexpected bytecode");
    const c = (fn) => pub.readContract({ address: addr, abi: SQUEEKBET_ABI, functionName: fn });
    const [core, token, mc] = await Promise.all([c("core"), c("token"), c("marketCreator")]);
    if (core.toLowerCase() !== CORE.toLowerCase()) return fail("wrong SqueekCore");
    if (token.toLowerCase() !== SQK.toLowerCase()) return fail("wrong token");
    if (CFG.creator && mc.toLowerCase() !== CFG.creator.toLowerCase()) return fail("wrong market creator");
    creator = mc;
    trusted = true;
    $("fakeWarn").classList.add("hidden");
    $("verified").className = "safe";
    $("verified").textContent = CFG.codeHash ? "✓ verified (bytecode, SqueekCore, SQK)" : "✓ verified (SqueekCore, SQK)";
  } catch (e) { fail("could not verify: " + errMsg(e)); }
}

// ---------- wallet ----------
function setAccount(a) {
  account = a || null;
  $("connect").textContent = account ? account.slice(0, 6) + "…" + account.slice(-4) : "Connect wallet";
  if (!account) $("bal").textContent = "";
  updateCreatePanel();
  loadBalance().catch(() => {});
  loadMarkets();
}

async function connect(silent = false) {
  if (!window.ethereum) { toast("Install MetaMask or another compatible wallet to bet."); return false; }
  if (!wallet) {
    wallet = createWalletClient({ chain: sepolia, transport: custom(window.ethereum) });
    if (typeof window.ethereum.on === "function") {
      window.ethereum.on("accountsChanged", (a) => setAccount(a && a[0]));
      window.ethereum.on("chainChanged", () => location.reload());
    }
  }
  const [a] = await wallet.requestAddresses();
  if (!silent) await ensureChain(); // run() checks the chain again before any transaction
  setAccount(a);
  return true;
}

// Every transaction goes to Sepolia: refuse to continue if the wallet stays on another chain.
async function ensureChain() {
  if ((await wallet.getChainId()) === sepolia.id) return;
  try { await wallet.switchChain({ id: sepolia.id }); }
  catch { await wallet.addChain({ chain: sepolia }); }
  if ((await wallet.getChainId()) !== sepolia.id) throw new Error("Switch your wallet to Sepolia to continue.");
}

async function loadBalance() {
  if (!account) return 0n;
  const b = await pub.readContract({ address: SQK, abi: ERC20_ABI, functionName: "balanceOf", args: [account] });
  $("bal").textContent = `${sqk(b)} SQK`;
  return b;
}

// Simulate first (catches reverts before the wallet prompt), then wait for the receipt and check it succeeded.
async function tx(address, abi, functionName, args, label) {
  const { request } = await pub.simulateContract({ address, abi, functionName, args, account });
  const hash = await wallet.writeContract(request);
  toast(`${label} sent… ⏳`, 120000);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} failed onchain (${hash.slice(0, 10)}…).`);
  return r;
}

// One action at a time: no double submits, buttons are disabled while a transaction is pending.
async function run(fn, { needsTrust = true } = {}) {
  if (busy) return toast("Please wait: a transaction is already in progress.");
  if (needsTrust && !trusted) return toast("Betting is disabled: this contract could not be verified.", 6000);
  if (!account && !(await connect().catch((e) => { toast(errMsg(e)); return false; }))) return;
  busy = true;
  document.body.classList.add("busy");
  render();
  try {
    await ensureChain();
    await fn();
  } catch (e) {
    toast(errMsg(e), 6000);
  } finally {
    busy = false;
    document.body.classList.remove("busy");
    await Promise.all([loadMarkets(), loadBalance()]).catch(() => {});
  }
}

const send = (functionName, id, label) => run(async () => {
  await tx(addr, SQUEEKBET_ABI, functionName, [id], label);
  toast(`${label} confirmed ✅`);
});

const placeBet = (id, yes, amount) => run(async () => {
  const bal = await loadBalance();
  if (bal < amount) throw new Error(`Not enough SQK. You have ${sqk(bal)} SQK.`);
  const allowance = await pub.readContract({ address: SQK, abi: ERC20_ABI, functionName: "allowance", args: [account, addr] });
  if (allowance < amount) {
    toast("Step 1/2: approve SQK…", 120000);
    await tx(SQK, ERC20_ABI, "approve", [addr, amount], "Approval"); // exact amount, never unlimited
  }
  toast("Step 2/2: placing your bet…", 120000);
  await tx(addr, SQUEEKBET_ABI, "bet", [id, yes, amount], "Bet");
  drafts.delete(String(id));
  toast(`Bet placed on ${yes ? "YES" : "NO"} ✅`);
});

// The contract has no batch claim: one transaction per market, each simulated, stopping at the first failure.
const claimAll = () => run(async () => {
  const ids = view.markets.filter((x) => x.pos && x.pos.state === "claimable").map((x) => x.id);
  if (!ids.length) throw new Error("There is nothing to claim.");
  let done = 0;
  try {
    for (const id of ids) {
      await tx(addr, SQUEEKBET_ABI, "claim", [id], `Claim ${done + 1}/${ids.length} (#${id})`);
      done++;
    }
  } catch (e) {
    throw new Error(`${done}/${ids.length} claimed. Stopped: ${errMsg(e)}`);
  }
  toast(`All ${done} claims confirmed ✅`);
});

async function deploy() {
  if (!account && !(await connect())) return;
  try {
    const hash = await wallet.deployContract({ abi: SQUEEKBET_ABI, bytecode: SQUEEKBET_BYTECODE, args: [CORE, SQK], account });
    $("deployOut").textContent = "Deploying… " + hash;
    const r = await pub.waitForTransactionReceipt({ hash });
    addr = r.contractAddress;
    store.set(STORE_KEY, addr);
    $("deployOut").textContent = `Deployed at ${addr}. Share this address so it can be added to config.js.`;
    showApp();
  } catch (e) { toast(errMsg(e), 6000); }
}

// ---------- markets: data ----------
async function multicall(calls) {
  if (!calls.length) return [];
  const res = await pub.multicall({ contracts: calls, allowFailure: true, batchSize: 8192 });
  return res.map((r) => (r.status === "success" ? r.result : null));
}

let loadSeq = 0;
async function loadMarkets() {
  if (!addr) return;
  const seq = ++loadSeq, who = account, settledAt = settled;
  const call = (functionName, args = []) => ({ address: addr, abi: SQUEEKBET_ABI, functionName, args });
  try {
    const count = Number(await pub.readContract(call("marketCount")));
    const ids = [];
    for (let i = count - 1; i >= Math.max(0, count - MAX_MARKETS); i--) ids.push(BigInt(i));
    const got = await multicall(ids.map((id) => call("getMarket", [id])));
    const markets = ids.map((id, i) => ({ id, m: got[i], mined: null, me: null, pos: null })).filter((x) => x.m);

    const started = markets.filter((x) => x.m.status === STATUS.OPEN && settledAt >= x.m.startRound);
    const mined = await multicall(started.map((x) => call("blocksBetween", [x.m.startRound, settledAt < x.m.endRound ? settledAt : x.m.endRound])));
    started.forEach((x, i) => (x.mined = mined[i]));

    if (who) {
      const r = await multicall(markets.flatMap((x) => [call("yesStake", [x.id, who]), call("noStake", [x.id, who]), call("claimable", [x.id, who]), call("claimed", [x.id, who])]));
      markets.forEach((x, i) => {
        x.me = { yes: r[4 * i] ?? 0n, no: r[4 * i + 1] ?? 0n, claimable: r[4 * i + 2] ?? 0n, claimed: r[4 * i + 3] ?? false };
        x.pos = positionOf(x.m, x.me);
      });
    }
    if (seq !== loadSeq || who !== account) return; // a newer load (or another account) superseded this one
    Object.assign(view, { markets, loaded: true, error: "", total: count });
  } catch (e) {
    if (seq !== loadSeq) return;
    view.error = "Could not load markets: " + errMsg(e);
  }
  render();
}

// ---------- markets: view ----------
const TAB_EMPTY = {
  all: "No markets yet. New markets open soon. Follow the live stream!",
  open: "No market is open for betting right now.",
  live: "No market is running right now.",
  settled: "No resolved market yet.",
  refunding: "No refunded market.",
  mine: "You have not placed any bet yet.",
};

function chipOf(x, ph, t) {
  const m = x.m;
  switch (ph.phase) {
    case "resolved": return { cls: m.yesWon ? "yes" : "no", text: `${m.yesWon ? "YES" : "NO"} won · ${int(m.blocksMined)} blocks mined` };
    case "refunding": return { cls: "", text: `Refunding${m.blocksMined ? ` · ${int(m.blocksMined)} blocks mined` : ""}` };
    case "open": return { cls: "open", text: `Betting open · closes in ${fmtDur(ph.start - t)}` };
    case "live": return { cls: "open", text: `Live 🐹 · ends in ${fmtDur(ph.end - t)}` };
    case "resolvable": return { cls: "open", text: "Ended · ready to resolve" };
    case "stalled": return { cls: "", text: "Settlement stalled · refund available" };
    default: return { cls: "", text: "Ended · waiting for onchain settlement" };
  }
}

const POS_LABEL = { active: "Your bet", claimable: "To claim", claimed: "Claimed ✓", lost: "Lost" };

function progressHtml(x) {
  const p = progressOf(x.m, x.mined, settled, ratePerRound);
  const stalled = x.ph.phase === "stalled";
  const lead = stalled ? "" : p.secured ? "YES locked in" : p.leader === "yes" ? "On pace for YES" : p.leader === "no" ? (p.done >= p.total ? "NO" : "On pace for NO") : "";
  const meta = [`${p.done}/${p.total} rounds settled`];
  if (p.projected !== null && !p.secured) meta.push(`projected ~${int(p.projected)} blocks`);
  return `<div class="prog">
    <div class="prog-top"><span>Blocks mined <b>${int(p.mined)}</b> / ${int(p.target)}</span>${lead ? `<span class="lead ${p.leader}">${esc(lead)}</span>` : ""}</div>
    <div class="pbar${p.secured ? " secured" : ""}" role="progressbar" aria-valuemin="0" aria-valuemax="${p.target}" aria-valuenow="${Math.min(p.mined, p.target)}"><i style="width:${p.pct.toFixed(1)}%"></i></div>
    <div class="prog-meta">${esc(meta.join(" · "))}</div>
  </div>`;
}

function quoteText(m, raw) {
  const a = parseAmount(raw);
  if (a === null) return "Enter an amount in SQK, e.g. 100 or 12.5.";
  if (a < MIN_BET) return "The minimum bet is 1 SQK.";
  const q = (yes) => {
    const p = payoutIfWins(m, yes, a);
    return `${sqk(p)} SQK (×${(Number((p * 1000n) / a) / 1000).toFixed(2)})`;
  };
  const thin = m.yesPool === 0n || m.noPool === 0n ? " Odds move as others bet; a one-sided market refunds everyone." : " Odds move as others bet.";
  return `Payout if you win · YES: ${q(true)} · NO: ${q(false)}.${thin}`;
}

function renderCard(x, t) {
  const { id, m, ph, pos } = x;
  const total = m.yesPool + m.noPool;
  const yesPct = total ? Number((m.yesPool * 10000n) / total) / 100 : 50;
  const mult = (yes) => { const v = multiplier(m, yes); return v === null ? "—" : v.toFixed(2) + "x"; };
  const won = m.status === STATUS.RESOLVED ? (m.yesWon ? "yes" : "no") : "";
  const chip = chipOf(x, ph, t);
  const dis = busy ? " disabled" : "";
  const side = (k, label, pct, pool, mine) => `<div class="side-box ${k}${won === k ? " won" : ""}">
      <div class="side-top"><span>${label}${won === k ? " ✓" : ""}</span><b>${pct.toFixed(0)}%</b></div>
      <div class="side-meta">${sqk(pool)} SQK · pays ${mult(k === "yes")}</div>
      ${mine ? `<div class="side-mine">Your stake: ${sqk(mine)} SQK</div>` : ""}
    </div>`;
  const state = ph.phase === "open" ? "open" : ph.tab;
  let html = `<article class="m" data-state="${state}" data-id="${id}">
    <div class="m-head"><span class="chip ${chip.cls}">${esc(chip.text)}</span><span class="m-tags">${pos ? `<span class="pos ${pos.state}">${POS_LABEL[pos.state]}</span>` : ""}<span class="m-id">#${id}</span></span></div>
    <h3 class="q">Will the hamster mine ${int(m.minBlocks)}+ block${m.minBlocks > 1n ? "s" : ""}?</h3>
    <div class="m-meta">${esc(fmtTime(ph.start))} → ${esc(fmtTime(ph.end))} · pool ${sqk(total)} SQK</div>`;
  if (["live", "settling", "resolvable", "stalled"].includes(ph.phase)) html += progressHtml(x);
  html += `<div class="bar" aria-hidden="true"><i style="width:${yesPct}%"></i></div>
    <div class="sides">${side("yes", "YES", yesPct, m.yesPool, x.me && x.me.yes)}${side("no", "NO", 100 - yesPct, m.noPool, x.me && x.me.no)}</div>`;
  let act = "";
  if (ph.phase === "open" && trusted) {
    const draft = drafts.get(String(id)) ?? "100";
    act += `<div class="amt"><input type="text" inputmode="decimal" autocomplete="off" maxlength="32" value="${esc(draft)}" id="amt${id}" data-amt="${id}" aria-label="Bet amount in SQK"><span>SQK</span></div>
      <button class="btn yes" data-act="bet" data-id="${id}" data-side="1"${dis}>Bet YES</button>
      <button class="btn no" data-act="bet" data-id="${id}" data-side="0"${dis}>Bet NO</button>
      <div class="quote" id="quote${id}" aria-live="polite">${esc(quoteText(m, draft))}</div>`;
  }
  if (ph.phase === "resolvable") act += `<button class="btn acc" data-act="resolve" data-id="${id}"${dis}>Resolve market</button>`;
  if (ph.phase === "stalled") act += `<button class="btn" data-act="triggerRefund" data-id="${id}"${dis}>Unlock refunds</button>`;
  if (pos && pos.state === "claimable") act += `<button class="btn acc" data-act="claim" data-id="${id}"${dis}>Claim ${sqk(pos.claimable)} SQK</button>`;
  if (act) html += `<div class="m-actions">${act}</div>`;
  return html + `</article>`;
}

function summaryHtml(items) {
  const s = summarize(items.map((x) => x.pos));
  return `<div class="summary">
    <div><span>${s.active}</span><small>Active bets</small></div>
    <div><span>${sqk(s.activeStake)}</span><small>SQK at stake</small></div>
    <div><span class="${s.claimableTotal > 0n ? "hot" : ""}">${sqk(s.claimableTotal)}</span><small>SQK to claim</small></div>
    ${s.claimableCount ? `<button class="btn acc" data-act="claimAll"${busy ? " disabled" : ""}>Claim all (${s.claimableCount})</button>` : ""}
  </div>`;
}

function render() {
  const t = now(), box = $("markets");
  if (!view.loaded) {
    if (view.error) { const p = document.createElement("p"); p.textContent = view.error; box.replaceChildren(p); }
    return;
  }
  const items = view.markets.map((x) => ({ ...x, ph: phaseOf(x.m, settled, t) }));
  const counts = Object.fromEntries(TABS.map((k) => [k, 0]));
  for (const x of items) { counts.all++; counts[x.ph.tab]++; if (x.pos) counts.mine++; }
  document.querySelectorAll(".tab").forEach((b) => {
    const on = b.dataset.tab === view.tab;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
    b.querySelector("i").textContent = counts[b.dataset.tab] || "";
  });
  $("mcount").textContent = view.total ? `${view.total} total` : "";

  let list = view.tab === "all" ? items : view.tab === "mine" ? items.filter((x) => x.pos) : items.filter((x) => x.ph.tab === view.tab);
  // open markets: the one closing soonest first; everything else: newest first
  if (view.tab === "open") list = [...list].sort((a, b) => a.ph.start - b.ph.start);

  let html = view.error ? `<p class="err">${esc(view.error)}</p>` : "";
  if (view.tab === "mine") {
    if (!account) html += `<div class="empty"><p>Connect your wallet to see your bets and claim your winnings.</p><button class="btn primary sm" data-act="connect">Connect wallet</button></div>`;
    else html += summaryHtml(items);
  }
  if (view.tab !== "mine" || account) html += list.length ? list.map((x) => renderCard(x, t)).join("") : `<p class="empty">${TAB_EMPTY[view.tab]}</p>`;

  // keep the bet input the user is typing in (focus + caret) across re-renders
  const ae = document.activeElement, focusId = ae && ae.dataset ? ae.dataset.amt : undefined;
  const caret = focusId ? [ae.selectionStart, ae.selectionEnd] : null;
  box.innerHTML = html;
  if (focusId) { const el = $("amt" + focusId); if (el) { el.focus(); try { el.setSelectionRange(caret[0], caret[1]); } catch {} } }
}

// ---------- create ----------
function formRounds() {
  const startMin = Math.max(1, Number($("fStart").value) || 1);
  const hours = Math.min(168, Math.max(1, Number($("fHours").value) || 1));
  // first round that begins at least startMin minutes from now (betting closes when it begins)
  const startRound = Math.max(roundNow(now()) + 1, Math.ceil((now() + startMin * 60 - GENESIS) / ROUND) + 1);
  return { startRound, endRound: startRound + hours * 6 - 1, hours };
}
function suggestLine() {
  if (ratePerRound === null) return;
  const { hours } = formRounds();
  $("fMin").value = Math.max(1, Math.round(ratePerRound * 6 * hours));
  updatePreview();
}
function updatePreview() {
  const { startRound, endRound } = formRounds();
  const open = fmtTime(roundStartTs(startRound)), close = fmtTime(roundStartTs(endRound + 1));
  $("preview").textContent = `"Will the hamster mine at least ${$("fMin").value} blocks between ${open} and ${close}?" Betting closes at ${open} (in ${Math.round((roundStartTs(startRound) - now()) / 60)} min).`
    + (ratePerRound !== null ? ` The 24h average pace is ${Math.round(ratePerRound * 6)} blocks/h.` : "");
}

// Only the market creator's wallet sees the create panel; the contract enforces it anyway.
function updateCreatePanel() {
  const isCreator = !!(account && creator && account.toLowerCase() === creator.toLowerCase());
  $("createCard").classList.toggle("hidden", !isCreator);
  $("createForm").classList.toggle("hidden", !isCreator);
  $("sideTitle").textContent = "Create a market";
}

async function showApp() {
  $("deployCard").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("addrOut").textContent = addr;
  await verifyContract();
  updateCreatePanel();
}

// ---------- events ----------
$("connect").onclick = () => connect().catch((e) => toast(errMsg(e)));
$("deploy").onclick = deploy;
$("fStart").oninput = updatePreview;
$("fHours").oninput = suggestLine;
$("fMin").oninput = updatePreview;
$("create").onclick = () => {
  const { startRound, endRound } = formRounds();
  const min = BigInt(Math.max(1, Math.floor(Number($("fMin").value)) || 1));
  run(async () => {
    await tx(addr, SQUEEKBET_ABI, "createMarket", [BigInt(startRound), BigInt(endRound), min], "Market creation");
    toast("Market created ✅");
  });
};
$("tabs").onclick = (ev) => {
  const b = ev.target.closest(".tab");
  if (!b || !TABS.includes(b.dataset.tab)) return;
  view.tab = b.dataset.tab;
  store.set(TAB_KEY, view.tab);
  render();
};
$("markets").addEventListener("input", (ev) => {
  const inp = ev.target.closest("[data-amt]");
  if (!inp) return;
  drafts.set(inp.dataset.amt, inp.value);
  const x = view.markets.find((v) => String(v.id) === inp.dataset.amt);
  const q = $("quote" + inp.dataset.amt);
  if (x && q) q.textContent = quoteText(x.m, inp.value);
});
$("markets").onclick = (ev) => {
  const b = ev.target.closest("[data-act]");
  if (!b || b.disabled) return;
  const act = b.dataset.act;
  if (act === "connect") return connect().catch((e) => toast(errMsg(e)));
  if (act === "claimAll") return claimAll();
  if (!/^\d{1,9}$/.test(b.dataset.id || "")) return;
  const id = BigInt(b.dataset.id);
  if (act === "bet") {
    const v = parseAmount($("amt" + b.dataset.id)?.value);
    if (v === null) return toast("Enter an amount in SQK, e.g. 100 or 12.5.");
    if (v < MIN_BET) return toast("The minimum bet is 1 SQK.");
    return placeBet(id, b.dataset.side === "1", v);
  }
  const label = { resolve: "Resolve", triggerRefund: "Refund unlock", claim: "Claim" }[act];
  if (label) send(act, id, label);
};

// ---------- boot ----------
if (addr) await showApp();
else { $("createCard").classList.remove("hidden"); $("deployCard").classList.remove("hidden"); $("sideTitle").textContent = "Deploy"; }
updatePreview();
await Promise.all([loadLive(), loadChain().catch(() => {})]);
await loadMarkets();
// reconnect silently if this site was already authorized in the wallet (no prompt)
if (window.ethereum) window.ethereum.request({ method: "eth_accounts" }).then((a) => { if (a && a[0]) connect(true).catch(() => {}); }).catch(() => {});

// livestream: X Media Studio player (embeddable anywhere); ON AIR follows the stream, not the wheel sensor
let broadcastId = "";
function setBroadcast(id) {
  if (!/^[A-Za-z0-9]{8,24}$/.test(id || "")) return;
  broadcastId = id;
  const player = `https://studio.x.com/embed/broadcast/${id}?dnt=true`;
  if ($("cam").src !== player) $("cam").src = player;
  document.querySelectorAll(".liveLink").forEach((a) => (a.href = `https://x.com/i/broadcasts/${id}`));
}
// the official site publishes the current broadcast in this file; find {kind:"x", broadcastId} wherever it sits
function findBroadcast(o, depth = 0) {
  if (!o || typeof o !== "object" || depth > 4) return "";
  if (typeof o.broadcastId === "string" && (o.kind === undefined || o.kind === "x")) return o.broadcastId;
  for (const v of Object.values(o)) { const id = findBroadcast(v, depth + 1); if (id) return id; }
  return "";
}
async function loadBroadcast() {
  try {
    const r = await fetch("https://media.squeekchain.com/live/current.json", { cache: "no-store" });
    setBroadcast(findBroadcast(await r.json()));
  } catch {}
  try {
    const r = await fetch(`https://studio.x.com/api/embeds/get-broadcast?broadcastId=${broadcastId}`, { cache: "no-store" });
    const bc = (await r.json())?.value?.broadcast || {};
    const live = bc.state === "Running";
    $("onair").textContent = live ? "ON AIR" : "OFF AIR";
    $("onair").classList.toggle("live", live);
    $("viewers").textContent = live && bc.totalWatching ? `${Number(bc.totalWatching).toLocaleString("en-US")} watching` : "";
  } catch {}
}
setBroadcast(CFG.broadcast);
loadBroadcast();
setInterval(loadBroadcast, 30000);
setInterval(loadLive, 15000);
setInterval(async () => { await loadChain().catch(() => {}); await loadMarkets(); }, 30000);
setInterval(() => { if (!busy) render(); }, 15000); // countdowns
