import { createPublicClient, createWalletClient, custom, http, parseEther, formatEther, parseAbi, keccak256, sepolia } from "./vendor/viem.js";
import { SQUEEKBET_ABI, SQUEEKBET_BYTECODE } from "./abi.js";

const CORE = "0x980B4424c007CAf7a1f3670B48c8EaEf7EbC3d44";
const SQK = "0x6872BfA5CcC3E9e440C6c16e5fFdAbb8DBA4Cc76";
const API = "https://api.squeekchain.com/v1";
const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const GENESIS = 1793022600, ROUND = 600, UNITS = 1000000000n, TIMEOUT = 86400;
const STORE_KEY = "squeekbet.v5.address";
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
  NothingToClaim: "There is nothing to claim.",
  NotMarketCreator: "Only the SqueekBet market creator can open markets.",
  AlreadyClaimed: "You already claimed this market.",
  TransferFailed: "The SQK transfer failed. Check your balance and approval.",
};

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
let wallet = null, account = null, settled = 0n, ratePerRound = null, trusted = false, creator = null;
const CFG = window.SQUEEKBET || {};
// The contract address only comes from config.js on this server (or this browser's own fresh deployment),
// never from the URL, so a shared link cannot point users at a fake contract.
let addr = CFG.address || store.get(STORE_KEY) || "";

const now = () => Math.floor(Date.now() / 1000);
const roundNow = () => (now() < GENESIS ? 0 : Math.floor((now() - GENESIS) / ROUND) + 1);
const roundStartTs = (r) => GENESIS + (Number(r) - 1) * ROUND;
function fmtTime(ts) {
  const d = new Date(ts * 1000), t = new Date();
  const hm = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === t.toDateString() ? hm : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) + ", " + hm;
}
function fmtDur(s) {
  if (s <= 0) return "0m";
  const h = Math.floor(s / 3600), m = Math.ceil((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
const sqk = (v) => Number(formatEther(v)).toLocaleString("en-US", { maximumFractionDigits: 2 });
function toast(msg, ms = 4000) {
  const t = $("toast"); t.textContent = msg; t.style.display = "block";
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.style.display = "none"), ms);
}
function errMsg(e) {
  const s = (e && (e.shortMessage || e.message)) || String(e);
  for (const k in ERRORS) if (s.includes(k)) return ERRORS[k];
  if (/User rejected|denied/i.test(s)) return "You rejected the transaction.";
  return s.split("\n")[0];
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
  $("round").textContent = roundNow().toLocaleString("en-US");
}

async function loadChain() {
  const st = await pub.readContract({ address: CORE, abi: CORE_ABI, functionName: "state" });
  settled = st.settledThroughRound;
  $("height").textContent = Number(st.blockHeight).toLocaleString("en-US");
  $("settled").textContent = Number(settled).toLocaleString("en-US");
  // pace over the last 24h of settled rounds (or since genesis on a young chain), refreshed every poll
  if (settled >= 2n) {
    const span = settled > 144n ? 144n : settled - 1n;
    const pt = (r) => pub.readContract({ address: CORE, abi: CORE_ABI, functionName: "roundPage", args: [r, r, 0n] });
    const [a, b] = await Promise.all([pt(settled - span), pt(settled)]);
    const blocks = Number(b.end.cumulativeBlockUnits - a.end.cumulativeBlockUnits) / Number(UNITS);
    const first = ratePerRound === null;
    ratePerRound = blocks / Number(span);
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
async function connect() {
  if (!window.ethereum) { toast("Install MetaMask or another compatible wallet to bet."); return false; }
  wallet = createWalletClient({ chain: sepolia, transport: custom(window.ethereum) });
  [account] = await wallet.requestAddresses();
  try { await wallet.switchChain({ id: sepolia.id }); }
  catch { await wallet.addChain({ chain: sepolia }); }
  $("connect").textContent = account.slice(0, 6) + "…" + account.slice(-4);
  updateCreatePanel();
  loadBalance();
  loadMarkets();
  return true;
}

async function loadBalance() {
  if (!account) return;
  const b = await pub.readContract({ address: SQK, abi: ERC20_ABI, functionName: "balanceOf", args: [account] });
  $("bal").textContent = `${sqk(b)} SQK`;
  return b;
}

async function tx(address, abi, functionName, args, label) {
  const { request } = await pub.simulateContract({ address, abi, functionName, args, account });
  const hash = await wallet.writeContract(request);
  toast(`${label || "Transaction"} sent… ⏳`, 30000);
  await pub.waitForTransactionReceipt({ hash });
}

async function send(functionName, args) {
  if (!trusted) return toast("Betting is disabled: this contract could not be verified.", 6000);
  if (!account && !(await connect())) return;
  try {
    await tx(addr, SQUEEKBET_ABI, functionName, args);
    toast("Confirmed ✅");
    await Promise.all([loadMarkets(), loadBalance()]);
  } catch (e) { toast(errMsg(e), 6000); }
}

async function placeBet(id, yes, amount) {
  if (!trusted) return toast("Betting is disabled: this contract could not be verified.", 6000);
  if (amount < 10n ** 18n) return toast("The minimum bet is 1 SQK.");
  if (!account && !(await connect())) return;
  try {
    const bal = await loadBalance();
    if (bal < amount) return toast(`Not enough SQK. You have ${sqk(bal)} SQK.`, 6000);
    const allowance = await pub.readContract({ address: SQK, abi: ERC20_ABI, functionName: "allowance", args: [account, addr] });
    if (allowance < amount) {
      toast("Step 1/2: approve SQK…", 30000);
      await tx(SQK, ERC20_ABI, "approve", [addr, amount], "Approval");
    }
    toast("Step 2/2: placing your bet…", 30000);
    await tx(addr, SQUEEKBET_ABI, "bet", [id, yes, amount], "Bet");
    toast(`Bet placed on ${yes ? "YES" : "NO"} ✅`);
    await Promise.all([loadMarkets(), loadBalance()]);
  } catch (e) { toast(errMsg(e), 6000); }
}

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

// ---------- markets ----------
function statusOf(m) {
  const t = now(), start = roundStartTs(m.startRound), end = roundStartTs(m.endRound + 1n);
  if (m.status === 1) return m.yesWon
    ? { chip: "yes", text: `YES won · ${m.blocksMined} blocks mined` }
    : { chip: "no", text: `NO won · ${m.blocksMined} blocks mined` };
  if (m.status === 2) return { chip: "", text: `Refunding${m.blocksMined ? ` · ${m.blocksMined} blocks mined` : ""}` };
  if (t < start) return { chip: "open", text: `Betting open · closes in ${fmtDur(start - t)}`, open: true };
  if (settled >= m.endRound) return { chip: "open", text: "Ended · ready to resolve", resolve: true };
  if (t >= end + TIMEOUT) return { chip: "", text: "Settlement stalled · refund available", refund: true };
  if (t < end) return { chip: "open", text: `Live 🐹 · ends in ${fmtDur(end - t)}` };
  return { chip: "", text: "Ended · waiting for onchain settlement" };
}

async function loadMarkets() {
  if (!addr) return;
  try {
    const c = (fn, args = []) => pub.readContract({ address: addr, abi: SQUEEKBET_ABI, functionName: fn, args });
    const count = Number(await c("marketCount"));
    if (!count) { $("markets").innerHTML = '<p>No markets yet. New markets open soon. Follow the live stream!</p>'; return; }
    const ids = [];
    for (let i = count - 1; i >= Math.max(0, count - 30); i--) ids.push(BigInt(i));
    const cards = await Promise.all(ids.map(async (id) => {
      const m = await c("getMarket", [id]);
      let progress = null, me = null;
      if (m.status === 0 && settled >= m.startRound) {
        progress = await c("blocksBetween", [m.startRound, settled < m.endRound ? settled : m.endRound]);
      }
      if (account) {
        const [y, n, cl] = await Promise.all([c("yesStake", [id, account]), c("noStake", [id, account]), c("claimable", [id, account])]);
        me = { y, n, cl };
      }
      return renderCard(id, m, statusOf(m), progress, me);
    }));
    $("markets").innerHTML = cards.join("");
    $("mcount").textContent = `${count} total`;
  } catch (e) {
    const p = document.createElement("p");
    p.className = "mut";
    p.textContent = "Could not load markets: " + errMsg(e);
    $("markets").replaceChildren(p);
  }
}

function renderCard(id, m, s, progress, me) {
  const total = m.yesPool + m.noPool;
  const yesPct = total ? Number((m.yesPool * 10000n) / total) / 100 : 50;
  const mult = (pool) => (pool ? (Number((total * 100n) / pool) / 100).toFixed(2) + "x" : "—");
  const start = roundStartTs(m.startRound), end = roundStartTs(m.endRound + 1n);
  const state = m.status !== 0 ? "settled" : s.open ? "open" : "live";
  const won = m.status === 1 ? (m.yesWon ? "yes" : "no") : "";
  const side = (k, label, pct, pool, mine) => `<div class="side-box ${k}${won === k ? " won" : ""}">
      <div class="side-top"><span>${label}${won === k ? " ✓" : ""}</span><b>${pct.toFixed(0)}%</b></div>
      <div class="side-meta">${sqk(pool)} SQK · pays ${mult(pool)}</div>
      ${mine ? `<div class="side-mine">Your stake: ${sqk(mine)} SQK</div>` : ""}
    </div>`;
  let html = `<article class="m" data-state="${state}">
    <div class="m-head"><span class="chip ${s.chip}">${s.text}</span><span class="m-id">#${id}</span></div>
    <h3 class="q">Will the hamster mine ${m.minBlocks}+ block${m.minBlocks > 1n ? "s" : ""}?</h3>
    <div class="m-meta">${fmtTime(start)} → ${fmtTime(end)} · pool ${sqk(total)} SQK${progress !== null ? ` · <b>${progress} block(s) settled so far</b>` : ""}</div>
    <div class="bar"><i style="width:${yesPct}%"></i></div>
    <div class="sides">${side("yes", "YES", yesPct, m.yesPool, me && me.y)}${side("no", "NO", 100 - yesPct, m.noPool, me && me.n)}</div>`;
  let act = "";
  if (s.open && trusted) act += `<div class="amt"><input type="number" step="1" min="1" value="100" id="amt${id}" aria-label="Bet amount in SQK"><span>SQK</span></div>
      <button class="btn yes" data-act="bet" data-id="${id}" data-side="1">Bet YES</button>
      <button class="btn no" data-act="bet" data-id="${id}" data-side="0">Bet NO</button>`;
  if (s.resolve) act += `<button class="btn acc" data-act="resolve" data-id="${id}">Resolve market</button>`;
  if (s.refund) act += `<button class="btn" data-act="triggerRefund" data-id="${id}">Unlock refunds</button>`;
  if (me && me.cl > 0n) act += `<button class="btn acc" data-act="claim" data-id="${id}">Claim ${sqk(me.cl)} SQK</button>`;
  if (act) html += `<div class="m-actions">${act}</div>`;
  return html + `</article>`;
}

// ---------- create ----------
function formRounds() {
  const startMin = Math.max(1, Number($("fStart").value) || 1);
  const hours = Math.min(168, Math.max(1, Number($("fHours").value) || 1));
  // first round that begins at least startMin minutes from now (betting closes when it begins)
  const startRound = Math.max(roundNow() + 1, Math.ceil((now() + startMin * 60 - GENESIS) / ROUND) + 1);
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
  loadMarkets();
}

$("connect").onclick = () => connect().catch((e) => toast(errMsg(e)));
$("deploy").onclick = deploy;
$("fStart").oninput = updatePreview;
$("fHours").oninput = suggestLine;
$("fMin").oninput = updatePreview;
$("create").onclick = () => {
  const { startRound, endRound } = formRounds();
  send("createMarket", [BigInt(startRound), BigInt(endRound), BigInt(Math.max(1, Number($("fMin").value) || 1))]);
};
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x === t));
  $("markets").dataset.tab = t.dataset.tab;
}));
$("markets").onclick = (ev) => {
  const b = ev.target.closest("[data-act]");
  if (!b) return;
  const id = BigInt(b.dataset.id), act = b.dataset.act;
  if (act === "bet") {
    let v;
    try { v = parseEther(String($("amt" + b.dataset.id).value || "0")); } catch { return toast("Invalid amount."); }
    placeBet(id, b.dataset.side === "1", v);
  } else send(act, [id]);
};

if (addr) await showApp(); else { $("createCard").classList.remove("hidden"); $("deployCard").classList.remove("hidden"); $("sideTitle").textContent = "Deploy"; }
updatePreview();
await Promise.all([loadLive(), loadChain().catch(() => {})]);
loadMarkets();
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
setInterval(async () => { await loadChain().catch(() => {}); loadMarkets(); }, 30000);
