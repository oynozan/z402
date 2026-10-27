#!/usr/bin/env bash
# Bring up the z402 Z3 regtest stack (Zebra + Zallet + Zaino) and wait until all three answer.
# Idempotent. The first run clones Z3 into .tools/z3, initialises the wallet and creates
# the account and the transparent miner address before Zallet ever starts.
# Override images with Z3_ZEBRA_IMAGE, Z3_ZALLET_IMAGE or Z3_ZAINO_IMAGE.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lib.sh"

step "Z3 checkout at $Z3_PIN"
mkdir -p "$TOOLS"
if [ ! -d "$Z3_DIR/.git" ]; then
  git clone --quiet "$Z3_REPO" "$Z3_DIR"
fi
if [ "$(git -C "$Z3_DIR" rev-parse HEAD)" != "$Z3_PIN" ]; then
  git -C "$Z3_DIR" fetch --quiet origin
  git -C "$Z3_DIR" checkout --quiet "$Z3_PIN"
fi
info "$(git -C "$Z3_DIR" log --oneline -1)"

step "gRPC probe dependencies"
if [ ! -d "$LWP_DIR/.git" ]; then
  git clone --quiet "$LWP_REPO" "$LWP_DIR"
fi
if [ "$(git -C "$LWP_DIR" rev-parse HEAD)" != "$LWP_PIN" ]; then
  git -C "$LWP_DIR" fetch --quiet origin
  git -C "$LWP_DIR" checkout --quiet "$LWP_PIN"
fi
if [ ! -d "$GRPC_DIR/node_modules/@grpc/grpc-js" ] || [ ! -d "$GRPC_DIR/node_modules/@grpc/proto-loader" ]; then
  npm install --silent --prefix "$GRPC_DIR" @grpc/grpc-js@1.14.6 @grpc/proto-loader@0.8.1
fi
info "lightwallet-protocol $(git -C "$LWP_DIR" rev-parse --short HEAD), @grpc/grpc-js in $GRPC_DIR"

step "Regtest config files"
"$Z3_DIR/scripts/setup-network.sh" regtest | sed 's/^/    /'
ZALLET_TOML="$Z3_DIR/config/regtest/zallet.toml"
if grep -q '^require_backup' "$ZALLET_TOML"; then
  info "zallet.toml already sets require_backup"
else
  awk '{ print } /^\[keystore\]$/ { print "require_backup = false" }' "$ZALLET_TOML" >"$ZALLET_TOML.tmp"
  mv "$ZALLET_TOML.tmp" "$ZALLET_TOML"
  chmod 644 "$ZALLET_TOML"
  info "zallet.toml: added require_backup = false under [keystore]"
fi
ZAINO_TOML="$Z3_DIR/config/regtest/zaino.toml"
recreate_zaino=""
if grep -q '^\[storage.database\]' "$ZAINO_TOML"; then
  info "zaino.toml already sets [storage.database]"
else
  # The default 384 GB LMDB map fails with ENOMEM under amd64 emulation on arm64
  printf '\n[storage.database]\nsize = 1\n' >>"$ZAINO_TOML"
  chmod 644 "$ZAINO_TOML"
  recreate_zaino="--force-recreate"
  info "zaino.toml: added [storage.database] size = 1 (GB)"
fi

step "Wallet initialisation (scripts/regtest-init.sh)"
# Z3 detects an initialised wallet by /data/*.age, which Zallet beta.1 never writes, so a rerun would delete wallet.db
volume_file "$INIT_FILE"
init_done="$FILE_FOUND"
volume_file "$MINER_FILE" cat
miner_found="$FILE_FOUND"
MINER="$FILE_TEXT"
if [ "$init_done" = 1 ] || [ "$miner_found" = 1 ]; then
  info "wallet volume already initialised, skipping"
else
  volume_file wallet.db
  if [ "$FILE_FOUND" = 1 ]; then
    die "$ZALLET_VOLUME has a wallet.db but no z402 marker, refusing to run regtest-init.sh (it would delete it). Start over with bash infra/z3/down.sh --wipe."
  fi
  (z3_env && "$Z3_DIR/scripts/regtest-init.sh") 2>&1 | sed 's/^/    /'
  write_marker "$INIT_FILE" "$(date -u +%FT%TZ)"
fi

step "Account 0 and transparent miner address"
if [ "$miner_found" = 1 ]; then
  case "$MINER" in
    tm*) ;;
    *) die "$ZALLET_VOLUME has $MINER_FILE but it holds '$MINER', not a regtest t-address" ;;
  esac
  info "miner address already created: $MINER"
else
  compose stop zallet >/dev/null 2>&1 || true
  out="$(compose run --rm --no-deps -T zallet --datadir /var/lib/zallet --config /etc/zallet/zallet.toml \
    regtest generate-account-and-miner-address)" || die "generate-account-and-miner-address failed: $out"
  MINER="$(printf '%s\n' "$out" | tail -n1 | tr -d '[:space:]')"
  case "$MINER" in
    tm*) ;;
    *) die "unexpected miner address output: $out" ;;
  esac
  write_marker "$MINER_FILE" "$MINER"
  info "created miner address $MINER"
fi

step "Starting zebra and zallet"
compose up -d zebra zallet 2>&1 | sed 's/^/    /'

step "Starting zaino ($Z3_ZAINO_IMAGE)"
compose --profile indexer up -d $recreate_zaino zaino 2>&1 | sed 's/^/    /'

step "Waiting for the services"
wait_for "Zebra getblockcount" 180 zrpc zebra getblockcount
wait_for "Zallet getwalletinfo" 300 zrpc zallet getwalletinfo
wait_for "Zaino GetLightdInfo" 600 node "$HERE/lwd.mjs" info

step "Checks"
height="$(zrpc zebra getblockcount)"
lightd="$(node "$HERE/lwd.mjs" info)"
branch="$(jq -r .consensusBranchId <<<"$lightd")"
chain="$(jq -r .chainName <<<"$lightd")"
info "Zebra height:            $height"
info "Zaino chainName:         $chain"
info "Zaino consensusBranchId: $branch"
[ "$height" -ge 2 ] || die "expected getblockcount >= 2, got $height"
[ "$branch" = "37a5165b" ] || die "expected consensusBranchId 37a5165b, got $branch"

step "Running images"
compose --profile indexer ps --format '{{.Service}}\t{{.Image}}\t{{.Status}}' | sed 's/^/    /'

cat <<EOF

Z3 regtest is up.
  Zebra RPC   http://127.0.0.1:29232  (zebra:zebra)
  Zallet RPC  http://127.0.0.1:50232  (zebra:zebra)
  Zaino gRPC  http://127.0.0.1:28137  (plaintext)
  MINER       $MINER
Next: bash infra/z3/fund-agent.sh
EOF
