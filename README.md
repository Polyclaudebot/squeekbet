# SqueekBet

Parimutuel prediction markets on the [Squeekchain](https://squeekchain.com) hamster. Live at **https://squeekbet.xyz**.

Each market asks: *will at least N Squeek blocks be mined during rounds X to Y?*
Players stake SQK on YES or NO; betting closes when the first round starts, and the winning side splits the whole pot.

## How it uses Squeekchain

- **Resolution without an oracle**: once the rounds are settled, anyone can call `resolve`, and the contract reads the certified ledger from **SqueekCore** (`roundPage`) to count the blocks mined. No admin can change the result.
- **Stakes in SQK**, the official Squeekchain token on Sepolia.
- **Refund safety**: if a market cannot be resolved within 24 h after its rounds end, it switches to refunding and every bettor gets their stake back.
- The only privileged role (`marketCreator`) can open markets, nothing else: it cannot move funds, cancel markets or influence results.
- The page embeds the live @squeekchain stream so you can watch the hamster while you bet.

## Deployment (Sepolia)

| | Address |
|---|---|
| SqueekBet | `0xc0402E84499d3970640F4a996E5ce2EbD51618c7` |
| SqueekCore | `0x980B4424c007CAf7a1f3670B48c8EaEf7EbC3d44` |
| SQK | `0x6872BfA5CcC3E9e440C6c16e5fFdAbb8DBA4Cc76` |

The web page checks the runtime codehash of the contract (`web/config.js`) and refuses to interact with anything else.

## Layout

```
src/SqueekBet.sol      the contract
test/                  Foundry tests (unit + fuzz) and bytecode verification
web/                   static front-end (no backend; talks to Sepolia via viem)
build/                 viem bundle (esbuild) and nginx config with strict CSP
deploy/                docker compose: nginx + Caddy (HTTPS)
```

## Build & test

```sh
forge install foundry-rs/forge-std
forge test
# fork tests against the live core
SEPOLIA_RPC=https://ethereum-sepolia-rpc.publicnode.com forge test
```

Rebuild the viem bundle: `cd build && npm ci && npx esbuild entry.js --bundle --format=esm --minify --outfile=../web/vendor/viem.js`

Serve: `cd deploy && docker compose up -d`

## License

MIT
