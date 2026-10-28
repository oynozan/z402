#!/usr/bin/env bash
# Regression checks for the wallet-init guard, volume matching, compose project pinning, loopback-only ports
# and the agent diversifier index that fund-agent.sh picks.
# Runs up.sh and down.sh against a fake docker on PATH with DOCKER_HOST pointed at a dead socket,
# and reads the merged compose config through the real docker CLI with that same dead socket.
# fund-agent.sh runs against a stub JSON-RPC server on a loopback port, with a balance high enough to skip funding,
# so nothing here can reach a real daemon or the live stack.
# Usage: bash infra/z3/test/guard.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
Z3="$(cd "$HERE/.." && pwd)"
[ -d "$Z3/../../.tools/z3/.git" ] || { echo "SKIP: run bash infra/z3/up.sh once first (needs .tools/z3)"; exit 0; }

REAL_DOCKER="$(command -v docker || true)"
WORK="$(mktemp -d)"
STUB_PID=""
trap '[ -z "$STUB_PID" ] || kill "$STUB_PID" 2>/dev/null; rm -rf "$WORK"' EXIT
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
want="compose -p z3-regtest -f docker-compose.yml -f docker-compose.regtest.yml -f $Z3/compose.loopback.yml --env-file .env.regtest up -d zebra zallet | COMPOSE_PROJECT_NAME=z3-regtest COMPOSE_FILE=unset Z3_CONFIG_DIR=unset"
if grep -q 'miner address already created: tmSHIMminer' "$WORK/out" && [ "$first" = "$want" ]; then
  pass "initialised wallet is skipped and compose ignores ambient COMPOSE_* and Z3_*"
else
  fail "initialised wallet skip and compose pinning"
  printf '      got:  %s\n      want: %s\n' "$first" "$want"
fi

export SHIM_COMPOSE_RC=0 SHIM_VOLUMES="z3-regtest-zallet domture-data"
run_case down.sh --wipe
down_call="$(grep '^compose' "$SHIM_LOG" | head -n1 || true)"
want="compose -p z3-regtest -f docker-compose.yml -f docker-compose.regtest.yml -f $Z3/compose.loopback.yml --env-file .env.regtest --profile * down --volumes --remove-orphans | COMPOSE_PROJECT_NAME=z3-regtest COMPOSE_FILE=unset Z3_CONFIG_DIR=unset"
if [ "$rc" -eq 0 ] && [ "$down_call" = "$want" ] && grep -q '^volume rm z3-regtest-zallet ' "$SHIM_LOG" &&
  ! grep -q '^volume rm domture-data' "$SHIM_LOG"; then
  pass "down.sh --wipe is pinned to z3-regtest and removes only z3-regtest volumes"
else
  fail "down.sh --wipe pinning (exit $rc)"
  sed 's/^/      log: /' "$SHIM_LOG"
fi

# fund-agent.sh takes the Orchard-only UA at the lowest diversifier index from 1 to 16 that accepts one, and moves on
# only when Zallet answers -4 "already generated with different receiver types". The stub answers over HTTP so the
# real rpc.mjs CLI produces the error text that fund-agent.sh matches. Its balance is above the funding floor.
if ! command -v node >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
  printf 'SKIP  fund-agent.sh diversifier index (needs node and jq)\n'
else
  cat >"$WORK/zallet-stub.mjs" <<'JS'
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const [portFile, scenarioFile, indexLog] = process.argv.slice(2);
const reuse = (i) => ({ code: -4, message: `Error: address at diversifier index ${i} was already generated with different receiver types.` });

createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const { id, method, params } = JSON.parse(raw);
    const scenario = readFileSync(scenarioFile, "utf8").trim();
    let result = null;
    let error;
    if (method === "getblockcount") result = 120;
    else if (method === "getwalletinfo") result = {};
    else if (method === "getwalletstatus") result = { wallet_tip: { height: 120 }, fully_synced_height: 120 };
    else if (method === "z_listaccounts") result = [{ account_uuid: "stub-account" }];
    else if (method === "z_getbalanceforaccount") result = { pools: { orchard: { valueZat: 500000000 } } };
    else if (method === "z_getaddressforaccount") {
      const index = params[2];
      appendFileSync(indexLog, `${index}\n`);
      const [kind, a, ...rest] = scenario.split(":");
      if (kind === "reuse-below" && index < Number(a)) error = reuse(index);
      else if (kind === "all-reuse") error = reuse(index);
      else if (kind === "error") error = { code: Number(a), message: rest.join(":") };
      else result = { account_uuid: "stub-account", diversifier_index: index, receiver_types: ["orchard"], address: `uregtest1stubagent${index}` };
    } else error = { code: -32601, message: "Method not found" };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result }));
  });
}).listen(0, "127.0.0.1", function () {
  writeFileSync(portFile, String(this.address().port));
});
JS
  : >"$WORK/scenario"
  : >"$WORK/indices"
  node "$WORK/zallet-stub.mjs" "$WORK/stub.port" "$WORK/scenario" "$WORK/indices" &
  STUB_PID=$!
  disown "$STUB_PID"
  for _ in $(seq 1 100); do [ -s "$WORK/stub.port" ] && break; sleep 0.1; done
  [ -s "$WORK/stub.port" ] || { echo "FAIL: the Zallet stub did not start"; exit 1; }
  stub_url="http://127.0.0.1:$(cat "$WORK/stub.port")"

  # run_agent_case <scenario>, leaves the status in $rc, the output in $WORK/out and the asked indices in $asked
  run_agent_case() {
    printf '%s' "$1" >"$WORK/scenario"
    : >"$WORK/indices"
    rc=0
    SHIM_RUN=ready SHIM_VOLUME_LS_RC=0 SHIM_VOLUMES=z3-regtest-zallet Z3_ZEBRA_RPC="$stub_url" Z3_ZALLET_RPC="$stub_url" \
      bash "$Z3/fund-agent.sh" >"$WORK/out" 2>&1 || rc=$?
    asked="$(paste -sd, "$WORK/indices")"
  }

  expect_agent() {
    local label="$1" want_asked="$2" want_index="$3"
    run_agent_case "$4"
    if [ "$rc" -eq 0 ] && [ "$asked" = "$want_asked" ] &&
      grep -q "agent   uregtest1stubagent$want_index (diversifier index $want_index)" "$WORK/out" &&
      grep -q "^AGENT_UA=uregtest1stubagent$want_index\$" "$WORK/out"; then
      pass "$label"
    else
      fail "$label (exit $rc, asked $asked)"
      sed 's/^/      /' "$WORK/out" | tail -5
    fi
  }

  expect_agent_failure() {
    local label="$1" want_asked="$2" want_message="$3"
    run_agent_case "$4"
    if [ "$rc" -ne 0 ] && [ "$asked" = "$want_asked" ] && grep -q -- "$want_message" "$WORK/out" && ! grep -q '^AGENT_UA=' "$WORK/out"; then
      pass "$label"
    else
      fail "$label (exit $rc, asked $asked)"
      sed 's/^/      /' "$WORK/out" | tail -5
    fi
  }

  all16="$(seq 1 16 | paste -sd, -)"
  expect_agent "fund-agent.sh keeps index 1 when it accepts an Orchard-only address" 1 1 "reuse-below:1"
  expect_agent "fund-agent.sh moves to index 2 when index 1 holds the default address" 1,2 2 "reuse-below:2"
  expect_agent "fund-agent.sh takes index 16 when 1 to 15 hold other receivers" "$all16" 16 "reuse-below:16"
  expect_agent_failure "fund-agent.sh stops at once on another -4 error" 1 "cannot generate an address with a Sapling receiver" \
    "error:-4:Error: cannot generate an address with a Sapling receiver"
  expect_agent_failure "fund-agent.sh stops at once on a reuse message with another code" 1 "-1 Error: address at diversifier index 1" \
    "error:-1:Error: address at diversifier index 1 was already generated with different receiver types."
  expect_agent_failure "fund-agent.sh gives up after 16 indices" "$all16" "no Orchard-only address at diversifier indices 1 to 16" "all-reuse"
fi

# Every port zebra, zaino and zallet publish, as the compose wrapper merges the files, must bind to loopback only
if [ -z "$REAL_DOCKER" ] || ! "$REAL_DOCKER" compose version >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
  printf 'SKIP  merged compose config (needs the docker compose CLI and jq, no daemon)\n'
else
  ports="$(
    HERE="$Z3"
    source "$Z3/lib.sh"
    docker() { "$REAL_DOCKER" "$@"; }
    compose --profile indexer config --format json | jq -r '.services | to_entries[]
      | select(.key == "zebra" or .key == "zaino" or .key == "zallet") | .key as $s
      | .value.ports[] | "\($s) \(.host_ip // "*"):\(.published)->\(.target)"' | sort
  )" || ports="compose config failed"
  want="$(printf '%s\n' 'zaino 127.0.0.1:28137->8137' 'zaino 127.0.0.1:28237->8237' 'zallet 127.0.0.1:50232->28232' \
    'zebra 127.0.0.1:28080->8080' 'zebra 127.0.0.1:29232->18232')"
  if [ "$ports" = "$want" ]; then
    pass "zebra, zaino and zallet publish their regtest ports on 127.0.0.1 only"
  else
    fail "merged compose config publishes beyond loopback"
    printf '%s\n' "$ports" | sed 's/^/      got:  /'
    printf '%s\n' "$want" | sed 's/^/      want: /'
  fi
fi

[ "$failures" -eq 0 ] && echo "all guard checks passed" || { echo "$failures check(s) failed"; exit 1; }
