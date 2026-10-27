#!/usr/bin/env bash
# Regression checks for the wallet-init guard, volume matching and compose project pinning in up.sh and down.sh.
# Runs both scripts against a fake docker on PATH with DOCKER_HOST pointed at a dead socket,
# so nothing here can reach a real daemon or the live stack.
# Usage: bash infra/z3/test/guard.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
Z3="$(cd "$HERE/.." && pwd)"
[ -d "$Z3/../../.tools/z3/.git" ] || { echo "SKIP: run bash infra/z3/up.sh once first (needs .tools/z3)"; exit 0; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir "$WORK/bin"
cat >"$WORK/bin/docker" <<'SHIM'
#!/usr/bin/env bash
printf '%s | COMPOSE_PROJECT_NAME=%s COMPOSE_FILE=%s Z3_CONFIG_DIR=%s\n' "$*" \
  "${COMPOSE_PROJECT_NAME-unset}" "${COMPOSE_FILE-unset}" "${Z3_CONFIG_DIR-unset}" >>"$SHIM_LOG"
case "$1" in
  compose) exit "${SHIM_COMPOSE_RC:-99}" ;;
  volume)
    if [ "$2" = ls ]; then
      [ "${SHIM_VOLUME_LS_RC:-0}" = 0 ] || exit "$SHIM_VOLUME_LS_RC"
      printf '%s\n' ${SHIM_VOLUMES:-}
    fi
    exit 0 ;;
  run)
    while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
    name="${2:-}"
    case "${SHIM_RUN:-fail}" in
      fail) echo "docker: Error response from daemon: shim failure" >&2; exit 125 ;;
      fresh) exit 11 ;;
      walletdb) [ "$name" = wallet.db ] && exit 10; exit 11 ;;
      ready) [ "$name" = z402-miner-address ] && printf tmSHIMminer; exit 10 ;;
    esac ;;
esac
exit 0
SHIM
chmod +x "$WORK/bin/docker"

export PATH="$WORK/bin:$PATH"
export DOCKER_HOST="unix://$WORK/no-daemon.sock"
export SHIM_LOG="$WORK/docker.log"
[ "$(command -v docker)" = "$WORK/bin/docker" ] || { echo "FAIL: shim docker is not first on PATH"; exit 1; }

failures=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }

# run_case <script> <args...>, with SHIM_* already exported, leaves output in $WORK/out and status in $rc
run_case() {
  : >"$SHIM_LOG"
  rc=0
  bash "$Z3/$1" "${@:2}" >"$WORK/out" 2>&1 || rc=$?
}

expect_guard_death() {
  local label="$1" message="$2"
  run_case up.sh
  if [ "$rc" -ne 0 ] && grep -q -- "$message" "$WORK/out" && ! grep -q '^compose' "$SHIM_LOG"; then
    pass "$label"
  else
    fail "$label (exit $rc)"
    sed 's/^/      /' "$WORK/out" | tail -5
    sed 's/^/      log: /' "$SHIM_LOG"
  fi
}

{
  printf 'z3-regtest-zallet\n'
  for i in $(seq 1 4000); do printf 'filler-volume-%05d-0123456789abcdef0123456789abcdef\n' "$i"; done
} >"$WORK/volumes"
# A long list after the target, where a pipe into grep -q can die of SIGPIPE under pipefail
if (
  HERE="$Z3"
  source "$Z3/lib.sh"
  docker() { cat "$WORK/volumes"; }
  set -o pipefail
  volume_present z3-regtest-zallet && ! volume_present z3-regtest-zall && ! volume_present filler-volume
); then
  pass "volume_present finds a volume at the head of a long list and matches whole names only"
else
  fail "volume_present on a long volume list"
fi

export SHIM_VOLUMES="z3-regtest-zallet"

export SHIM_RUN=fail SHIM_VOLUME_LS_RC=0
expect_guard_death "docker run failure stops up.sh before regtest-init" "cannot inspect /data/z402-init-done"

export SHIM_RUN=fresh SHIM_VOLUME_LS_RC=1
expect_guard_death "docker volume ls failure stops up.sh before regtest-init" "docker volume ls failed"

export SHIM_RUN=walletdb SHIM_VOLUME_LS_RC=0
expect_guard_death "wallet.db without a marker stops up.sh before regtest-init" "refusing to run regtest-init.sh"

export SHIM_RUN=ready COMPOSE_PROJECT_NAME=evil COMPOSE_FILE=evil.yml Z3_CONFIG_DIR=/evil
run_case up.sh
first="$(grep '^compose' "$SHIM_LOG" | head -n1 || true)"
want="compose -p z3-regtest -f docker-compose.yml -f docker-compose.regtest.yml --env-file .env.regtest up -d zebra zallet | COMPOSE_PROJECT_NAME=z3-regtest COMPOSE_FILE=unset Z3_CONFIG_DIR=unset"
if grep -q 'miner address already created: tmSHIMminer' "$WORK/out" && [ "$first" = "$want" ]; then
  pass "initialised wallet is skipped and compose ignores ambient COMPOSE_* and Z3_*"
else
  fail "initialised wallet skip and compose pinning"
  printf '      got:  %s\n      want: %s\n' "$first" "$want"
fi

export SHIM_COMPOSE_RC=0 SHIM_VOLUMES="z3-regtest-zallet domture-data"
run_case down.sh --wipe
down_call="$(grep '^compose' "$SHIM_LOG" | head -n1 || true)"
want="compose -p z3-regtest -f docker-compose.yml -f docker-compose.regtest.yml --env-file .env.regtest --profile * down --volumes --remove-orphans | COMPOSE_PROJECT_NAME=z3-regtest COMPOSE_FILE=unset Z3_CONFIG_DIR=unset"
if [ "$rc" -eq 0 ] && [ "$down_call" = "$want" ] && grep -q '^volume rm z3-regtest-zallet ' "$SHIM_LOG" &&
  ! grep -q '^volume rm domture-data' "$SHIM_LOG"; then
  pass "down.sh --wipe is pinned to z3-regtest and removes only z3-regtest volumes"
else
  fail "down.sh --wipe pinning (exit $rc)"
  sed 's/^/      log: /' "$SHIM_LOG"
fi

[ "$failures" -eq 0 ] && echo "all guard checks passed" || { echo "$failures check(s) failed"; exit 1; }
