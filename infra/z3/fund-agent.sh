#!/usr/bin/env bash
# Fund the agent wallet on Z3 regtest and print AGENT_UA and its spendable balance.
# Mines 110 blocks of transparent coinbase to the Zallet miner address, shields up to 10 mature
# UTXOs to the agent's Orchard-only UA (account 0, diversifier index 1), then mines one block.
# Skips funding when the agent already holds at least 1 ZEC, unless --force is given.
# --probe also prints Zaino GetTransaction for the shield tx in the mempool and once mined.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lib.sh"

force=0
probe=0
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    --probe) probe=1 ;;
    *) die "usage: bash infra/z3/fund-agent.sh [--force] [--probe]" ;;
  esac
done

MIN_ZAT=100000000
AGENT_DIVERSIFIER=1

wallet_synced() {
  local tip status
  tip="$(zrpc zebra getblockcount)"
  status="$(zrpc zallet getwalletstatus)"
  [ "$(jq -r '.wallet_tip.height // -1' <<<"$status")" = "$tip" ] &&
    [ "$(jq -r '.fully_synced_height // -1' <<<"$status")" = "$tip" ]
}

spendable_zat() {
  zrpc zallet z_getbalanceforaccount "$ACCOUNT" 1 |
    jq '[.pools.ironwood.valueZat // 0, .pools.orchard.valueZat // 0] | add'
}

probe_tx() {
  printf '    Zaino GetTransaction %s (%s):\n' "$1" "$2"
  node "$HERE/lwd.mjs" tx "$1" | sed 's/^/      /' || true
}

step "Checking the stack"
zrpc zebra getblockcount >/dev/null 2>&1 || die "Zebra does not answer, run bash infra/z3/up.sh"
zrpc zallet getwalletinfo >/dev/null 2>&1 || die "Zallet does not answer, run bash infra/z3/up.sh"
MINER="$(read_marker "$MINER_FILE")"
[ -n "$MINER" ] || die "no miner address in $ZALLET_VOLUME, run bash infra/z3/up.sh"
ACCOUNT="$(zrpc zallet z_listaccounts | jq -r '.[0].account_uuid')"
AGENT_UA="$(zrpc zallet z_getaddressforaccount "$ACCOUNT" '["orchard"]' "$AGENT_DIVERSIFIER" | jq -r .address)"
info "account $ACCOUNT"
info "miner   $MINER"
info "agent   $AGENT_UA"

wait_for "Zallet sync" 300 wallet_synced
have="$(spendable_zat)"
if [ "$have" -ge "$MIN_ZAT" ] && [ "$force" -eq 0 ]; then
  info "agent already holds $have zat spendable, skipping funding (use --force to fund again)"
else
  step "Mining 110 blocks of coinbase to the miner address"
  t0=$SECONDS
  zrpc zebra generatetoaddress 110 "$MINER" >/dev/null
  info "tip $(zrpc zebra getblockcount) after $(( SECONDS - t0 ))s"
  wait_for "Zallet sync" 600 wallet_synced

  step "Shielding mature coinbase to the agent UA"
  t0="$(date +%s)"
  shield="$(zrpc zallet z_shieldcoinbase "$MINER" "$AGENT_UA" null 10)"
  printf '%s\n' "$shield" | sed 's/^/    /'
  opid="$(jq -r .opid <<<"$shield")"
  for _ in $(seq 1 600); do
    op="$(zrpc zallet z_getoperationresult "[\"$opid\"]")"
    status="$(jq -r '.[0].status // "pending"' <<<"$op")"
    case "$status" in
      success) break ;;
      failed) die "z_shieldcoinbase failed: $(jq -c '.[0].error' <<<"$op")" ;;
    esac
    sleep 0.5
  done
  [ "$status" = "success" ] || die "z_shieldcoinbase did not finish within 300s"
  TXID="$(jq -r '.[0].result.txid // .[0].result.txids[0]' <<<"$op")"
  info "shield txid $TXID ($(( $(date +%s) - t0 ))s from call to success)"

  if [ "$probe" -eq 1 ]; then
    for _ in $(seq 1 30); do
      node "$HERE/lwd.mjs" tx "$TXID" >/dev/null 2>&1 && break
      sleep 1
    done
    probe_tx "$TXID" "mempool, tip $(zrpc zebra getblockcount)"
  fi

  step "Mining 1 block"
  node "$HERE/clock.mjs" mine 1 | sed 's/^/    /'
  wait_for "Zallet sync" 300 wallet_synced
  if [ "$probe" -eq 1 ]; then
    probe_tx "$TXID" "mined, tip $(zrpc zebra getblockcount)"
  fi

  have="$(spendable_zat)"
  [ "$have" -ge "$MIN_ZAT" ] || die "agent spendable balance is only $have zat after funding"
fi

step "Agent wallet"
zrpc zallet z_getbalanceforaccount "$ACCOUNT" 1 | sed 's/^/    /'
printf '\nAGENT_ACCOUNT=%s\nAGENT_UA=%s\nSPENDABLE_ZAT=%s\n' "$ACCOUNT" "$AGENT_UA" "$have"
