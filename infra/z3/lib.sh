# Shared settings for the z402 Z3 regtest scripts, sourced by up.sh, down.sh and fund-agent.sh

REPO_ROOT="$(cd "$HERE/../.." && pwd)"
TOOLS="$REPO_ROOT/.tools"

Z3_DIR="$TOOLS/z3"
Z3_REPO="https://github.com/ZcashFoundation/z3"
Z3_PIN="e84ce9fd8e864ff0b2a8a62f6ce14392145db0fb"
Z3_PROJECT="z3-regtest"

LWP_DIR="$TOOLS/lightwallet-protocol"
LWP_REPO="https://github.com/zcash/lightwallet-protocol"
LWP_PIN="ec53075c706e78a4e107e7d3c92eea4e70262647"

GRPC_DIR="$TOOLS/grpc-probe"

# Z3 pins Zaino 0.6.0, which reports a mempool tx at the tip height
export Z3_ZAINO_IMAGE="${Z3_ZAINO_IMAGE:-zingodevops/zainod:0.10.2-no-tls}"

ZALLET_VOLUME="$Z3_PROJECT-zallet"
Z3_VOLUMES="$Z3_PROJECT-chain $Z3_PROJECT-cookie $Z3_PROJECT-zaino $Z3_PROJECT-zallet $Z3_PROJECT-zallet-ca-certificates"
INIT_FILE="z402-init-done"
MINER_FILE="z402-miner-address"

step() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Drops ambient COMPOSE_* and Z3_* (except image overrides) so a shell setting cannot retarget a compose call
z3_env() {
  local v
  for v in $(compgen -e); do
    case "$v" in
      Z3_ZEBRA_IMAGE | Z3_ZALLET_IMAGE | Z3_ZAINO_IMAGE) ;;
      COMPOSE_* | Z3_*) unset "$v" ;;
    esac
  done
  export COMPOSE_PROJECT_NAME="$Z3_PROJECT"
}

compose() {
  (
    z3_env
    cd "$Z3_DIR"
    docker compose -p "$Z3_PROJECT" -f docker-compose.yml -f docker-compose.regtest.yml \
      --env-file .env.regtest "$@"
  )
}

zrpc() { node "$HERE/rpc.mjs" "$@"; }

# Succeeds when the named volume exists, and dies when Docker cannot list volumes
volume_present() {
  local names
  names="$(docker volume ls -q)" || die "docker volume ls failed, cannot tell whether $1 exists"
  case $'\n'"$names"$'\n' in
    *$'\n'"$1"$'\n'*) return 0 ;;
    *) return 1 ;;
  esac
}

# Sets FILE_FOUND (1 or 0) and FILE_TEXT for /data/<name> in the wallet volume, and dies when it cannot look
volume_file() {
  local name="$1" mode="${2:-test}" rc=0
  FILE_FOUND=0
  FILE_TEXT=""
  volume_present "$ZALLET_VOLUME" || return 0
  FILE_TEXT="$(docker run --rm -v "$ZALLET_VOLUME:/data" busybox sh -c \
    'if [ -f "/data/$1" ]; then if [ "$2" = cat ]; then cat "/data/$1" || exit 12; fi; exit 10; fi; exit 11' \
    -- "$name" "$mode")" || rc=$?
  case "$rc" in
    10) FILE_FOUND=1 ;;
    11) FILE_TEXT="" ;;
    *) die "cannot inspect /data/$name in volume $ZALLET_VOLUME (docker run exit $rc), stopping before anything touches the wallet" ;;
  esac
}

# Markers live in the wallet volume so they are wiped together with the wallet
write_marker() {
  docker run --rm -v "$ZALLET_VOLUME:/data" busybox sh -c 'printf %s "$2" > "/data/$1"' -- "$1" "$2" ||
    die "cannot write /data/$1 in volume $ZALLET_VOLUME"
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
