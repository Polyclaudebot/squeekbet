#!/usr/bin/env bash
# Fresh local Sepolia fork + test markets for e2e.py. Nothing here touches the real chain.
set -e
R=https://ethereum-sepolia-rpc.publicnode.com L=http://127.0.0.1:8545
SQK=0x6872BfA5CcC3E9e440C6c16e5fFdAbb8DBA4Cc76 SB=0xc0402E84499d3970640F4a996E5ce2EbD51618c7
A=0xAAdCfB0197ef3f59bE97e004FA29E01CFd4d4CBB B=0x000000000000000000000000000000000000b0b0
cast() { docker run --rm --network host --entrypoint cast ghcr.io/foundry-rs/foundry:stable "$@" </dev/null; }
docker rm -f sb-anvil >/dev/null 2>&1 || true
docker run -d --name sb-anvil --network host --entrypoint anvil ghcr.io/foundry-rs/foundry:stable --fork-url $R --host 127.0.0.1 --port 8545 --auto-impersonate --chain-id 11155111 --silent >/dev/null
until cast block-number --rpc-url $L >/dev/null 2>&1; do sleep 1; done
for w in $A $B; do
  cast rpc anvil_setBalance $w 0x56BC75E2D63100000 --rpc-url $L >/dev/null                                            # 100 ETH for gas
  cast rpc anvil_setStorageAt $SQK $(cast index address $w 0) $(cast to-uint256 1000000000000000000000) --rpc-url $L >/dev/null  # 1000 SQK (balances at slot 0)
done
NOWR=$(cast call $SB 'currentRound()(uint64)' --rpc-url $L)
cast send $SB 'createMarket(uint64,uint64,uint64)' $((NOWR+3)) $((NOWR+8)) 5 --unlocked --from $A --rpc-url $L >/dev/null  # #2
cast send $SB 'createMarket(uint64,uint64,uint64)' $((NOWR+2)) $((NOWR+2)) 1 --unlocked --from $A --rpc-url $L >/dev/null  # #3
cast send $SQK 'approve(address,uint256)' $SB 100000000000000000000 --unlocked --from $B --rpc-url $L >/dev/null
cast send $SB 'bet(uint256,bool,uint256)' 2 false 50000000000000000000 --unlocked --from $B --rpc-url $L >/dev/null
cast send $SB 'bet(uint256,bool,uint256)' 3 false 50000000000000000000 --unlocked --from $B --rpc-url $L >/dev/null
echo "{\"endRound2\": $((NOWR+8))}" > seed.json
echo "seeded: round $NOWR, markets $(cast call $SB 'marketCount()(uint256)' --rpc-url $L)"
