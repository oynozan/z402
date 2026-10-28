#!/bin/sh
# One-time setup of the Zallet wallet volume (the zallet-init job of compose.yaml), a port of Z3's
# scripts/regtest-init.sh (MIT, see LICENSE) and infra/z3/up.sh. It creates the wallet, its mnemonic, account 0 and
# the transparent miner address before Zallet's first normal start, then writes a marker and never runs again: Z3's
# own guard looks for /var/lib/zallet/*.age, which Zallet beta.1 never writes, so a rerun would delete wallet.db.
set -eu

DATA=/var/lib/zallet
MARKER="$DATA/z402-init-done"
MINER_FILE="$DATA/z402-miner-address"
# The funding job reads the miner address from this public volume, so only Zallet mounts the wallet
PUBLIC=/chain-info/miner-address
# The agent pays from account 0's Orchard-only address at this diversifier index (packages/client, wallet-fund.mjs)
AGENT_INDEX=1
ATTEMPTS=10

zallet() {
  /usr/local/bin/zallet-zaino --datadir "$DATA" --config /etc/zallet/zallet.toml "$@"
}

is_taddr() {
  case "$1" in
    tm*) return 0 ;;
    *) return 1 ;;
  esac
}

publish() {
  printf '%s\n' "$1" >"$PUBLIC.tmp"
  mv "$PUBLIC.tmp" "$PUBLIC"
}

# Runs Zallet just long enough to answer listaddresses, and prints the answer. The binary is started directly, not
# through the zallet function, so that $! is Zallet itself and not a subshell that would leave it running.
list_addresses() {
  /usr/local/bin/zallet-zaino --datadir "$DATA" --config /etc/zallet/zallet.toml start >/tmp/zallet-check.log 2>&1 &
  pid=$!
  answer=""
  tries=0
  while [ "$tries" -lt 120 ]; do
    if answer="$(wget -q -O - -T 5 --header 'Authorization: Basic emVicmE6emVicmE=' \
      --header 'Content-Type: application/json' \
      --post-data '{"jsonrpc":"2.0","id":1,"method":"listaddresses","params":[]}' http://127.0.0.1:28232/ 2>/dev/null)"; then
      break
    fi
    kill -0 "$pid" 2>/dev/null || break
    tries=$((tries + 1))
    sleep 1
  done
  kill "$pid" 2>/dev/null || true
  # Zallet stops on SIGTERM within a second; the guard kills one that hangs. Its output goes elsewhere, since its sleep
  # would otherwise hold the pipe of $(list_addresses) open for 30 s.
  (sleep 30 && kill -9 "$pid") >/dev/null 2>&1 &
  guard=$!
  wait "$pid" 2>/dev/null || true
  kill "$guard" 2>/dev/null || true
  rm -f "$DATA/.lock"
  printf '%s' "$answer"
}

if [ -f "$MARKER" ]; then
  miner="$(cat "$MINER_FILE" 2>/dev/null || true)"
  if ! is_taddr "$miner"; then
    echo "zallet-init: $MARKER exists but $MINER_FILE holds no regtest t-address; start over with docker compose down -v" >&2
    exit 1
  fi
  publish "$miner"
  echo "zallet-init: wallet already initialised, miner address $miner"
  exit 0
fi

# Account 0's default address takes the first diversifier index that is valid for Sapling, which depends on the seed
# and is the agent's index for about one seed in four. Such a wallet is created again from a new mnemonic.
attempt=1
while :; do
  echo "zallet-init: creating the wallet (attempt $attempt)"
  # Left by an interrupted run or a refused seed, which nothing has used yet: a stale database breaks
  # init-wallet-encryption
  rm -f "$DATA/wallet.db" "$DATA/wallet.db-journal" "$DATA/wallet.db-wal" "$DATA/wallet.db-shm" "$DATA/.lock" "$MINER_FILE"
  # generate-encryption-identity refuses to overwrite the identity an interrupted run already wrote
  if [ ! -f "$DATA/identity.txt" ]; then
    zallet generate-encryption-identity
  fi
  zallet init-wallet-encryption
  zallet generate-mnemonic
  out="$(zallet regtest generate-account-and-miner-address)"
  miner="$(printf '%s\n' "$out" | tail -n 1 | tr -d '[:space:]')"
  if ! is_taddr "$miner"; then
    echo "zallet-init: generate-account-and-miner-address printed no regtest t-address: $out" >&2
    exit 1
  fi

  addresses="$(list_addresses)"
  case "$addresses" in
    *'"diversifier_index":'*) ;;
    *)
      echo "zallet-init: Zallet did not answer listaddresses; its last lines:" >&2
      tail -n 20 /tmp/zallet-check.log >&2
      exit 1
      ;;
  esac
  case "$addresses" in
    *"\"diversifier_index\":$AGENT_INDEX,"*) ;;
    *) break ;;
  esac
  if [ "$attempt" -ge "$ATTEMPTS" ]; then
    echo "zallet-init: the default address took diversifier index $AGENT_INDEX in $ATTEMPTS wallets in a row" >&2
    exit 1
  fi
  echo "zallet-init: the default address took diversifier index $AGENT_INDEX, which the agent needs; new mnemonic"
  attempt=$((attempt + 1))
done

printf '%s' "$miner" >"$MINER_FILE"
publish "$miner"
date -u +%Y-%m-%dT%H:%M:%SZ >"$MARKER"
echo "zallet-init: done, miner address $miner"
