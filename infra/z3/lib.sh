# Shared settings for the z402 Z3 regtest scripts, sourced by up.sh, down.sh and fund-agent.sh

REPO_ROOT="$(cd "$HERE/../.." && pwd)"
TOOLS="$REPO_ROOT/.tools"

Z3_DIR="$TOOLS/z3"
Z3_REPO="https://github.com/ZcashFoundation/z3"
Z3_PIN="e84ce9fd8e864ff0b2a8a62f6ce14392145db0fb"

LWP_DIR="$TOOLS/lightwallet-protocol"
LWP_REPO="https://github.com/zcash/lightwallet-protocol"
LWP_PIN="ec53075c706e78a4e107e7d3c92eea4e70262647"

GRPC_DIR="$TOOLS/grpc-probe"

# Z3 pins Zaino 0.6.0, which reports a mempool tx at the tip height
export Z3_ZAINO_IMAGE="${Z3_ZAINO_IMAGE:-zingodevops/zainod:0.10.2-no-tls}"

ZALLET_VOLUME="z3-regtest-zallet"
INIT_FILE="z402-init-done"
MINER_FILE="z402-miner-address"

step() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

compose() { (cd "$Z3_DIR" && docker compose --env-file .env.regtest "$@"); }
zrpc() { node "$HERE/rpc.mjs" "$@"; }

volume_exists() { docker volume inspect "$ZALLET_VOLUME" >/dev/null 2>&1; }

# Markers live in the wallet volume so they are wiped together with the wallet
read_marker() {
  volume_exists || return 0
  docker run --rm -v "$ZALLET_VOLUME:/data" busybox sh -c 'cat "/data/$1" 2>/dev/null || true' -- "$1"
}

write_marker() {
  docker run --rm -v "$ZALLET_VOLUME:/data" busybox sh -c 'printf %s "$2" > "/data/$1"' -- "$1" "$2"
}

# wait_for <label> <timeout-seconds> <command...>
wait_for() {
  local label="$1" timeout="$2" start=$SECONDS
  shift 2
  until "$@" >/dev/null 2>&1; do
    if (( SECONDS - start >= timeout )); then
      die "$label did not answer within ${timeout}s"
    fi
    sleep 2
  done
  info "$label answers ($(( SECONDS - start ))s)"
}
