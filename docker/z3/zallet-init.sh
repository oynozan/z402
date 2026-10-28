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

echo "zallet-init: creating the wallet"
# Left by an interrupted run, which nothing has used yet: a stale database breaks init-wallet-encryption
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

printf '%s' "$miner" >"$MINER_FILE"
publish "$miner"
date -u +%Y-%m-%dT%H:%M:%SZ >"$MARKER"
echo "zallet-init: done, miner address $miner"
