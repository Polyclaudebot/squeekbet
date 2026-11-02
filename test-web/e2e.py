# End-to-end test of the staging page against a local Sepolia fork (anvil, 127.0.0.1:8545).
# A mock wallet forwards transactions to anvil (auto-impersonate): real approve/bet/refund/claim, no keys.
import json, time, urllib.request, sys
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8092/"
RPC = "http://127.0.0.1:8545"
A = "0xAAdCfB0197ef3f59bE97e004FA29E01CFd4d4CBB"
GENESIS, ROUND = 1793022600, 600
results = []

def check(name, cond, info=""):
    results.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{info}]" if info else ""), flush=True)

def rpc(method, params):
    req = urllib.request.Request(RPC, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(), {"content-type": "application/json"})
    return json.loads(urllib.request.urlopen(req).read())["result"]

def mock(offset_ms):
    return """
    (() => {
      const OFF = %d, n = Date.now.bind(Date); Date.now = () => n() + OFF;
      const ACC = "%s"; let id = 0; const ls = {};
      window.ethereum = { isMetaMask: true,
        on(e, f) { (ls[e] ||= []).push(f); }, removeListener() {},
        async request({ method, params }) {
          if (method === "eth_requestAccounts" || method === "eth_accounts") return [ACC];
          if (method === "eth_chainId") return "0xaa36a7";
          if (method.startsWith("wallet_")) return null;
          if (method === "eth_sendTransaction") { window.__sent = (window.__sent || 0) + 1; await new Promise((r) => setTimeout(r, 1500)); } // user confirming in the wallet
          const r = await fetch("%s", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
          const j = await r.json(); if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code }); return j.result;
        } };
    })();""" % (offset_ms, A, RPC)

def wait(page, expr, arg=None, timeout=30000):
    # polls with page.evaluate: wait_for_function needs eval, which the site CSP (rightly) forbids
    end = time.time() + timeout / 1000
    while time.time() < end:
        if page.evaluate(f"(arg) => ({expr})", arg): return
        time.sleep(0.25)
    raise TimeoutError(expr)

def toast(page, text, timeout=90000):
    wait(page, "document.getElementById('toast').textContent.includes(arg)", text, timeout)

def tab(page, name):
    page.click(f'.tab[data-tab="{name}"]'); page.wait_for_timeout(150)

def overflow(page):
    return page.evaluate("document.documentElement.scrollWidth > window.innerWidth")

with sync_playwright() as p:
    b = p.chromium.launch()
    errors = []
    # ---------- phase 1: betting ----------
    ctx = b.new_context(viewport={"width": 1440, "height": 900}); ctx.add_init_script(mock(0))
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    # network failures are logged by URL; squeekchain.com is blocked from the VPS IP by Cloudflare (expected here)
    external = ("squeekchain.com", "studio.x.com")
    page.on("requestfailed", lambda r: errors.append("request failed: " + r.url) if not any(d in r.url for d in external) else None)
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and not m.text.startswith("Failed to load resource") and "squeekchain.com" not in m.text else None)
    page.goto(URL, wait_until="domcontentloaded")
    wait(page, "document.getElementById('verified').textContent.includes('verified')", timeout=30000)
    page.wait_for_selector("#markets .m", timeout=30000)
    wait(page, "document.getElementById('connect').textContent.startsWith('0x')", timeout=15000)
    check("silent reconnect of an authorized wallet", True)
    counts = page.evaluate("Object.fromEntries([...document.querySelectorAll('.tab')].map(t => [t.dataset.tab, t.querySelector('i').textContent]))")
    check("tab counts", counts["all"] == "4" and counts["open"] == "2" and counts["refunding"] == "2", json.dumps(counts))

    tab(page, "open")
    ids = page.eval_on_selector_all("#markets .m", "els => els.map(e => e.dataset.id)")
    check("open tab: closing soonest first", ids == ["3", "2"], str(ids))

    q = lambda i: page.inner_text(f"#quote{i}")
    page.fill("#amt3", "abc"); check("quote rejects garbage", "Enter an amount" in q(3))
    page.fill("#amt3", "-5"); check("quote rejects negatives", "Enter an amount" in q(3))
    page.fill("#amt3", "0.5"); check("quote enforces 1 SQK minimum", "minimum" in q(3))
    page.fill("#amt3", "30")
    check("quote = contract formula (YES 30*80/30 = 80, NO one-sided = stake back)", "YES: 80 SQK (×2.67)" in q(3) and "NO: 30 SQK (×1.00)" in q(3), q(3))

    page.click('[data-act="bet"][data-id="3"][data-side="1"]')
    page.wait_for_timeout(300)
    busy = page.evaluate("({ busy: document.body.classList.contains('busy'), disabled: document.querySelectorAll('#markets [data-act][disabled]').length })")
    check("buttons locked while a transaction is pending", busy["busy"] and busy["disabled"] > 0, json.dumps(busy))
    toast(page, "Bet placed on YES")
    check("bet #3 YES 30 SQK (approve + bet)", page.evaluate("window.__sent") == 2, f"tx sent: {page.evaluate('window.__sent')}")

    wait(page, "!document.body.classList.contains('busy')")
    page.fill("#amt2", "20"); page.click('[data-act="bet"][data-id="2"][data-side="1"]')
    toast(page, "Bet placed on YES")
    wait(page, "!document.body.classList.contains('busy')")
    page.wait_for_timeout(500)

    tab(page, "mine")
    summ = page.inner_text(".summary").replace("\n", " ")
    check("my bets summary: 2 active, 50 SQK at stake", summ.startswith("2 ") and "50 SQK AT STAKE" in summ.upper(), summ)
    tags = page.eval_on_selector_all("#markets .pos", "els => els.map(e => e.textContent)")
    check("my bets lists only my markets", tags == ["Your bet", "Your bet"], str(tags))
    check("store remembers the tab", page.evaluate("localStorage.getItem('squeekbet.tab')") == "mine")

    tab(page, "open")
    page.fill("#amt2", "77"); page.focus("#amt2")
    page.wait_for_timeout(16500)  # one countdown re-render (15 s)
    kept = page.evaluate("({ v: document.getElementById('amt2').value, f: document.activeElement.id })")
    check("typed amount and focus survive re-renders", kept == {"v": "77", "f": "amt2"}, json.dumps(kept))
    page.screenshot(path="e2e-open.png", full_page=True)
    ctx.close()

    # ---------- phase 2: 24h+ after market #2 ends, settlement never came (fork) -> refunds ----------
    end2 = GENESIS + json.load(open("seed.json"))["endRound2"] * ROUND  # end of market #2 (seed.sh)
    target = max(end2, int(time.time())) + 86400 + 600
    rpc("evm_setNextBlockTimestamp", [hex(target)]); rpc("evm_mine", [])
    off = int((target - time.time()) * 1000) + 5000
    ctx = b.new_context(viewport={"width": 1440, "height": 900}); ctx.add_init_script(mock(off))
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and not m.text.startswith("Failed to load resource") and "squeekchain.com" not in m.text else None)
    page.goto(URL, wait_until="domcontentloaded")
    page.wait_for_selector("#markets .m", timeout=30000)
    wait(page, "document.getElementById('connect').textContent.startsWith('0x')", timeout=15000)
    tab(page, "live")
    chips = page.eval_on_selector_all("#markets .chip", "els => els.map(e => e.textContent)")
    check("stalled markets offer refunds", len(chips) == 2 and all("refund available" in c for c in chips), str(chips))
    progress = page.eval_on_selector_all("#markets .prog-top", "els => els.map(e => e.textContent.trim())")
    check("progress block shown on started markets", len(progress) == 2, str(progress))
    for i in ("3", "2"):
        wait(page, "!document.body.classList.contains('busy')")
        page.click(f'[data-act="triggerRefund"][data-id="{i}"]'); toast(page, "Refund unlock confirmed")
    wait(page, "!document.body.classList.contains('busy')"); page.wait_for_timeout(500)
    tab(page, "mine")
    summ = page.inner_text(".summary").replace("\n", " ")
    check("2 refunds to claim (50 SQK)", "50 SQK TO CLAIM" in summ.upper() and "CLAIM ALL (2)" in summ.upper(), summ)
    page.screenshot(path="e2e-mine-desktop.png", full_page=True)
    page.set_viewport_size({"width": 390, "height": 844}); page.wait_for_timeout(300)
    check("mobile: no horizontal scroll", not overflow(page))
    page.screenshot(path="e2e-mine-mobile.png", full_page=True)
    page.set_viewport_size({"width": 1440, "height": 900})
    sent0 = page.evaluate("window.__sent")
    page.click('[data-act="claimAll"]'); toast(page, "All 2 claims confirmed")
    check("claim all = 2 transactions", page.evaluate("window.__sent") - sent0 == 2)
    wait(page, "!document.body.classList.contains('busy')"); page.wait_for_timeout(800)
    tags = page.eval_on_selector_all("#markets .pos", "els => els.map(e => e.textContent)")
    check("positions now claimed", tags == ["Claimed ✓", "Claimed ✓"], str(tags))
    check("no claim button left", page.query_selector('[data-act="claimAll"]') is None)
    check("balance back to 1,000 SQK", page.inner_text("#bal") == "1,000 SQK", page.inner_text("#bal"))
    ctx.close(); b.close()
    check("no JS errors", not errors, "; ".join(errors[:5]))

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
