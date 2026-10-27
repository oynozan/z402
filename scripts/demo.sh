#!/usr/bin/env bash
# Orchestrates the z402 3-minute demo on the local Z3 regtest stack.
#
#   scripts/demo.sh up                    Z3 stack, then facilitator (4022), then API (4021)
#   scripts/demo.sh clock                 block clock, one block every 25 s
#   scripts/demo.sh honest [--calls N]    honest agent in the foreground
#   scripts/demo.sh cheat                 cheating agent in the foreground
#   scripts/demo.sh show [txid]           raw deposit transaction, then decrypted with the viewing key
#   scripts/demo.sh status                process liveness, Zebra height, agent wallet balance
#   scripts/demo.sh down [--wipe-ledger]  stop what this script started
#
# The clock, facilitator and API run detached in their own session. Each has a pidfile and a log
# in .data/demo/ (gitignored), and the pid doubles as its process group id, so down can SIGINT the
# whole pnpm chain. The pidfile also records the process start time, and the leader and any
# leaderless group must carry the command marker, so a recycled pid is very unlikely to pass for
# ours. The script never touches Docker except through infra/z3/up.sh, and it never prints the
# merchant viewing key (UIVK) or the facilitator token. Runbook: docs/demo.md.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

NETWORK="regtest"
DATA="$ROOT/.data/demo"
TOKEN_FILE="$DATA/token"
KEYS="$ROOT/.secrets/merchant-regtest.json"
ZDECRYPT="$ROOT/crates/zdecrypt/target/release/zdecrypt"
LEDGER="$ROOT/.data/facilitator-ledger.$NETWORK.jsonl"

FAC_PORT=4022
API_PORT=4021
FAC_URL="http://127.0.0.1:$FAC_PORT"
API_URL="http://127.0.0.1:$API_PORT"
FAC_READY="facilitator listening on $FAC_URL"
API_READY="api listening on $API_URL"
CLOCK_READY="block clock:"
READY_TIMEOUT=60
CLOCK_EVERY=25
FLOOR_ZAT=250000

# Detaches into a new session, restores default SIGINT and SIGHUP, then execs the command
DETACH='use POSIX; POSIX::setsid(); $SIG{INT} = "DEFAULT"; $SIG{HUP} = "DEFAULT"; exec { $ARGV[0] } @ARGV or die "cannot run $ARGV[0]: $!\n"'

usage() {
  cat <<'EOF'
usage: scripts/demo.sh <command>

  up                    bring up the Z3 regtest stack, then start the facilitator and the API
  clock                 start the block clock in the background (one block every 25 s)
  honest [--calls N]    run the honest agent in the foreground (default 150 calls, one per second)
  cheat                 run the cheating agent in the foreground (one deposit, then none)
  show [txid]           show a deposit's raw transaction, then decrypt it with the viewing key
                        (no txid means the newest deposit the agent wallet sent)
  status                process liveness, Zebra height, the agent wallet's spendable balance
  down [--wipe-ledger]  stop the clock, the API and the facilitator that this script started
  --help                print this text

State lives in .data/demo/ (pidfiles, logs, the facilitator token). Runbook: docs/demo.md
EOF
}

step() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

need() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "$c is required but was not found on PATH"
  done
}

zrpc() { node "$ROOT/infra/z3/rpc.mjs" "$@"; }

commas() {
  local n="$1" out=""
  while [ "${#n}" -gt 3 ]; do
    out=",${n: -3}$out"
    n="${n%???}"
  done
  printf '%s%s' "$n" "$out"
}

# Blanks the token and the UIVK in anything echoed from a log
redact() {
  local tok="" key="" expr=""
  if [ -r "$TOKEN_FILE" ]; then tok="$(cat "$TOKEN_FILE")"; fi
  if [ -r "$KEYS" ] && command -v jq >/dev/null 2>&1; then key="$(jq -r '.uivk // empty' "$KEYS" 2>/dev/null || true)"; fi
  case "$tok" in '' | *[!0-9A-Za-z]*) tok="" ;; esac
  case "$key" in '' | *[!0-9A-Za-z]*) key="" ;; esac
  if [ -n "$tok" ]; then expr="$expr;s|$tok|<token>|g"; fi
  if [ -n "$key" ]; then expr="$expr;s|$key|<uivk>|g"; fi
  if [ -z "$expr" ]; then cat; else sed -e "${expr#;}"; fi
}

tail_log() {
  if [ -s "$1" ]; then
    tail -n 20 "$1" | redact | sed 's/^/    | /' >&2
  else
    printf '    | (the log is empty)\n' >&2
  fi
}

clear_z402_env() {
  local v
  for v in $(compgen -e); do
    case "$v" in Z402_*) unset "$v" ;; esac
  done
}

pid_of() { head -n 1 "$DATA/$1.pid" 2>/dev/null | tr -d '[:space:]' || true; }

started_of() { sed -n 2p "$DATA/$1.pid" 2>/dev/null || true; }

pgid_of() { ps -o pgid= -p "$1" 2>/dev/null | tr -d ' ' || true; }

lstart_of() { LC_ALL=C TZ=UTC0 ps -o lstart= -p "$1" 2>/dev/null | tr -s ' ' | sed 's/^ //; s/ $//' || true; }

proc_exists() { [ -n "$(ps -p "$1" -o pid= 2>/dev/null | tr -d ' ')" ]; }

# True when some process of process group $1 has $2 in its command line
group_has_marker() {
  ps -A -ww -o pgid=,command= 2>/dev/null | awk -v g="$1" -v m="$2" '$1 == g && index($0, m) { found = 1 } END { exit !found }'
}

command_of() { ps -ww -o command= -p "$1" 2>/dev/null || true; }

marker_of() {
  case "$1" in
    facilitator) printf '%s' "@z402/facilitator" ;;
    api) printf '%s' "@z402/api" ;;
    clock) printf '%s' "clock.mjs" ;;
  esac
}

# A pidfile is two lines, the pid and the process start time that spawn recorded, and anything else is stale
pid_ok() {
  local pid
  pid="$(pid_of "$1")"
  case "$pid" in '' | *[!0-9]*) return 1 ;; esac
  [ "$pid" -gt 1 ] || return 1
  [ -n "$(started_of "$1")" ]
}

# True only for the very process spawn started, so a recycled pid is never taken for ours
is_alive() {
  local name="$1" pid
  pid_ok "$name" || return 1
  pid="$(pid_of "$name")"
  kill -0 "$pid" 2>/dev/null || return 1
  [ "$(pgid_of "$pid")" = "$pid" ] || return 1
  [ "$(lstart_of "$pid")" = "$(started_of "$name")" ] || return 1
  case "$(command_of "$pid")" in *"$(marker_of "$name")"*) return 0 ;; esac
  return 1
}

# The leader no longer exists and a member of its process group still carries our marker, so the group is ours
is_orphaned() {
  local pid
  pid_ok "$1" || return 1
  pid="$(pid_of "$1")"
  if proc_exists "$pid"; then return 1; fi
  group_has_marker "$pid" "$(marker_of "$1")"
}

# Returns 0 when it runs already, dies when only orphaned members are left, returns 1 when it is safe to spawn
already_running() {
  if is_alive "$1"; then
    info "$1 already running (pid $(pid_of "$1"))"
    return 0
  fi
  if is_orphaned "$1"; then
    die "the $1 leader exited but members of its process group still run, stop them with scripts/demo.sh down first"
  fi
  return 1
}

# Bounds a command to 10 s by killing the child, since a Go binary such as docker ignores SIGALRM
BOUND='my $p = fork // exit 127; unless ($p) { exec @ARGV or exit 127 } $SIG{ALRM} = sub { kill "TERM", $p; sleep 1; kill "KILL", $p; waitpid $p, 0; exit 142 }; alarm 10; waitpid $p, 0; exit($? & 127 ? 1 : $? >> 8)'

docker_answers() { { perl -e "$BOUND" -- docker info >/dev/null; } 2>/dev/null; }

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

guard_port() {
  if port_open "$1"; then
    die "port $1 is taken by a process this script did not start, and the $2 needs it (find it with: lsof -nP -iTCP:$1 -sTCP:LISTEN)"
  fi
}

# spawn <name> <command...> runs it detached at the repo root, output to .data/demo/<name>.log (the old log moves to .log.prev)
spawn() {
  local name="$1" pid i=0
  shift
  mkdir -p "$DATA"
  rm -f "$DATA/$name.pid"
  if [ -s "$DATA/$name.log" ]; then mv -f "$DATA/$name.log" "$DATA/$name.log.prev"; fi
  : >"$DATA/$name.log"
  (
    cd "$ROOT"
    perl -e "$DETACH" -- "$@" </dev/null >>"$DATA/$name.log" 2>&1 &
    pid=$!
    printf '%s\n%s\n' "$pid" "$(lstart_of "$pid")" >"$DATA/$name.pid"
  )
  pid="$(pid_of "$name")"
  while [ "$i" -lt 30 ]; do
    if [ "$(pgid_of "$pid")" = "$pid" ]; then return 0; fi
    if ! kill -0 "$pid" 2>/dev/null; then return 0; fi
    sleep 0.1
    i=$((i + 1))
  done
  return 0
}

# wait_ready <label> <name> <line> <seconds> returns once the log holds the line, else prints the log tail and exits 1
wait_ready() {
  local label="$1" name="$2" pattern="$3" timeout="$4" start=$SECONDS log line
  log="$DATA/$name.log"
  until grep -qF -- "$pattern" "$log" 2>/dev/null; do
    if ! is_alive "$name"; then
      printf 'ERROR: %s exited before it printed "%s". Last lines of .data/demo/%s.log\n' "$label" "$pattern" "$name" >&2
      tail_log "$log"
      if ! is_orphaned "$name"; then rm -f "$DATA/$name.pid"; fi
      exit 1
    fi
    if [ $((SECONDS - start)) -ge "$timeout" ]; then
      printf 'ERROR: %s did not print "%s" within %ss. Last lines of .data/demo/%s.log\n' "$label" "$pattern" "$timeout" "$name" >&2
      tail_log "$log"
      printf 'It is still running. Stop it with scripts/demo.sh down.\n' >&2
      exit 1
    fi
    sleep 1
  done
  line="$(grep -F -- "$pattern" "$log" | head -n 1 | redact)"
  info "$label ready after $((SECONDS - start))s: $line"
}

ensure_token() {
  mkdir -p "$DATA"
  if [ ! -s "$TOKEN_FILE" ]; then
    (
      umask 077
      openssl rand -hex 16 >"$TOKEN_FILE"
    )
  fi
  chmod 600 "$TOKEN_FILE"
  [ -s "$TOKEN_FILE" ] || die "could not create $TOKEN_FILE"
  info "facilitator token in .data/demo/token (mode 600, never printed)"
}

merchant_pay_to() {
  local pay_to
  pay_to="$(jq -r '.orchardOnlyAddress // empty' "$KEYS")"
  [ -n "$pay_to" ] || die ".orchardOnlyAddress is missing from .secrets/merchant-regtest.json"
  printf '%s' "$pay_to"
}

start_facilitator() {
  local token
  if already_running facilitator; then return 0; fi
  guard_port "$FAC_PORT" facilitator
  token="$(cat "$TOKEN_FILE")"
  info "starting pnpm --filter @z402/facilitator start, log .data/demo/facilitator.log"
  (
    clear_z402_env
    # Absolute paths, since pnpm --filter runs the package from its own directory
    export Z402_NETWORK="$NETWORK" Z402_FACILITATOR_TOKEN="$token" Z402_MERCHANT_KEYS_FILE="$KEYS" Z402_LEDGER="$LEDGER"
    spawn facilitator pnpm --filter @z402/facilitator start
  )
}

start_api() {
  local token pay_to
  if already_running api; then return 0; fi
  guard_port "$API_PORT" api
  token="$(cat "$TOKEN_FILE")"
  pay_to="$(merchant_pay_to)"
  info "starting pnpm --filter @z402/api start, log .data/demo/api.log"
  (
    clear_z402_env
    export Z402_NETWORK="$NETWORK" Z402_FACILITATOR_TOKEN="$token" Z402_FACILITATOR_URL="$FAC_URL" Z402_PAY_TO="$pay_to"
    spawn api pnpm --filter @z402/api start
  )
}

cmd_up() {
  [ $# -eq 0 ] || die "up takes no arguments"
  need jq openssl node pnpm perl docker
  [ -f "$KEYS" ] || die ".secrets/merchant-regtest.json is missing (a zdecrypt keygen JSON for the regtest merchant)"
  [ -x "$ZDECRYPT" ] || die "crates/zdecrypt/target/release/zdecrypt is not built (pnpm --filter @z402/facilitator build:native)"
  docker_answers || die "Docker is not running or did not answer 'docker info' within 10s, start it and retry"

  step "Z3 regtest stack (infra/z3/up.sh)"
  bash "$ROOT/infra/z3/up.sh"

  step "Facilitator token"
  ensure_token

  step "Facilitator on $FAC_URL"
  start_facilitator
  wait_ready "facilitator" facilitator "$FAC_READY" "$READY_TIMEOUT"

  step "API on $API_URL"
  start_api
  wait_ready "api" api "$API_READY" "$READY_TIMEOUT"

  step "The demo stack is up"
  info "facilitator  $FAC_URL  (log .data/demo/facilitator.log)"
  info "api          $API_URL  (log .data/demo/api.log)"
  info "next         scripts/demo.sh status, then clock, then honest"
}

cmd_clock() {
  [ $# -eq 0 ] || die "clock takes no arguments"
  need node perl
  if already_running clock; then return 0; fi
  zrpc zebra getblockcount >/dev/null 2>&1 || die "Zebra does not answer, run scripts/demo.sh up"
  step "Block clock, one block every ${CLOCK_EVERY}s"
  spawn clock node "$ROOT/infra/z3/clock.mjs" run --every "$CLOCK_EVERY"
  wait_ready "block clock" clock "$CLOCK_READY" 10
  info "the first block is mined now, log .data/demo/clock.log"
}

# Refuses to start an agent run against a stack that is not listening
agent_preflight() {
  need pnpm
  port_open "$FAC_PORT" || die "nothing listens on $FAC_URL, run scripts/demo.sh up"
  port_open "$API_PORT" || die "nothing listens on $API_URL, run scripts/demo.sh up"
  if ! is_alive clock; then
    warn "the block clock is not running, so no deposit will confirm (start it with scripts/demo.sh clock)"
  fi
}

cmd_honest() {
  local calls=150
  while [ $# -gt 0 ]; do
    case "$1" in
      --calls)
        [ $# -ge 2 ] || die "--calls needs a number"
        calls="$2"
        shift 2
        ;;
      --calls=*)
        calls="${1#--calls=}"
        shift
        ;;
      *) die "honest: unknown argument $1 (usage: scripts/demo.sh honest [--calls N])" ;;
    esac
  done
  case "$calls" in
    '' | 0* | *[!0-9]*) die "--calls: expected a positive integer, got \"$calls\"" ;;
  esac
  [ "${#calls}" -le 10 ] || die "--calls: $calls is too large"
  agent_preflight
  cd "$ROOT"
  exec pnpm --filter @z402/agent demo --calls "$calls" --interval-ms 1000
}

cmd_cheat() {
  [ $# -eq 0 ] || die "cheat takes no arguments"
  agent_preflight
  cd "$ROOT"
  exec pnpm --filter @z402/agent demo --cheat --interval-ms 0 --calls 400
}

# Deposit memo transactions of the agent wallet, newest first, without expired or zero-value ones
DEPOSIT_TXIDS='[.[] | select(.expired_unmined != true) | select(any(.outputs[]?; ((.memo // "") | test("^[0-9a-f]{64}:[0-9]+$")) and ((.value // 0) > 0)))] | sort_by(.mined_height // 1e12) | reverse | .[].txid'

# The newest deposit transaction that Zebra knows, so an unbroadcast one cannot shadow a mined one
newest_deposit_txid() {
  local account rows txid
  account="$(zrpc zallet z_listaccounts | jq -r '.[0].account_uuid // empty')" || return 1
  [ -n "$account" ] || return 1
  rows="$(zrpc zallet z_listtransactions "\"$account\"")" || return 1
  for txid in $(jq -r "$DEPOSIT_TXIDS" <<<"$rows" | head -n 10); do
    if zrpc zebra getrawtransaction "\"$txid\"" 0 >/dev/null 2>&1; then
      printf '%s' "$txid"
      return 0
    fi
  done
  return 0
}

cmd_show() {
  local txid="${1:-}" tmp raw_json height tip hex_len out uivk pay_to at_flag at_value
  [ $# -le 1 ] || die "usage: scripts/demo.sh show [txid]"
  if [ $# -eq 0 ]; then
    need jq node
    step "Newest deposit in the agent wallet"
    txid="$(newest_deposit_txid 2>/dev/null)" || die "could not read the agent wallet's transactions from Zallet (is the stack up?)"
    [ -n "$txid" ] || die "the agent wallet has sent no z402 deposit yet, pass a txid"
    info "$txid"
  fi
  case "$txid" in
    *[!0-9a-f]*) die "the txid must be 64 lowercase hex characters" ;;
  esac
  [ "${#txid}" -eq 64 ] || die "the txid must be 64 lowercase hex characters"

  if [ -f "$HERE/show-deposit.sh" ]; then
    exec bash "$HERE/show-deposit.sh" "$txid"
  fi

  need jq node
  [ -x "$ZDECRYPT" ] || die "crates/zdecrypt/target/release/zdecrypt is not built (pnpm --filter @z402/facilitator build:native)"
  [ -f "$KEYS" ] || die ".secrets/merchant-regtest.json is missing"
  tmp="$(mktemp "${TMPDIR:-/tmp}/z402-tx.XXXXXX")"
  trap "rm -f '$tmp'" EXIT

  step "Deposit $txid"
  zrpc zebra getrawtransaction "\"$txid\"" 0 >"$tmp" || die "Zebra has no transaction $txid"
  hex_len="$(tr -d '[:space:]' <"$tmp" | wc -c | tr -d ' ')"
  case "$(tr -d '[:space:]' <"$tmp")" in
    '' | *[!0-9a-f]*) die "Zebra returned something that is not transaction hex" ;;
  esac
  raw_json="$(zrpc zebra getrawtransaction "\"$txid\"" 1)" || die "Zebra could not describe transaction $txid"
  height="$(jq -r '.height // empty' <<<"$raw_json")"
  if [ -n "$height" ]; then
    at_flag="--height"
    at_value="$height"
    info "mined at height $height"
  else
    tip="$(zrpc zebra getblockcount)"
    at_flag="--tip"
    at_value="$tip"
    info "still in the mempool, judged at tip $tip + 1"
  fi
  info "raw transaction: $((hex_len / 2)) bytes ($hex_len hex characters)"
  info "starts with:     $(head -c 96 "$tmp")..."
  info "That hex is all a block explorer has. It carries no plaintext amount and no address, only ciphertext."

  uivk="$(jq -r '.uivk // empty' "$KEYS")"
  pay_to="$(merchant_pay_to)"
  [ -n "$uivk" ] || die ".uivk is missing from .secrets/merchant-regtest.json"

  step "Decrypted with the merchant's viewing key (UIVK, not printed)"
  if ! out="$(ZDECRYPT_KEY="$uivk" "$ZDECRYPT" decrypt --network "$NETWORK" "$at_flag" "$at_value" --pay-to "$pay_to" --tx-file "$tmp" --pretty)"; then
    printf '%s\n' "$out" | redact >&2
    die "zdecrypt could not decrypt the transaction"
  fi
  printf '%s\n' "$out"
}

spendable_zat() {
  local account balance
  account="$(zrpc zallet z_listaccounts | jq -r '.[0].account_uuid // empty')" || return 1
  [ -n "$account" ] || return 1
  balance="$(zrpc zallet z_getbalanceforaccount "$account" 1)" || return 1
  jq '[.pools.ironwood.valueZat // 0, .pools.orchard.valueZat // 0] | add' <<<"$balance"
}

print_proc() {
  local name="$1" note=""
  if is_alive "$name"; then
    case "$name" in
      facilitator)
        if grep -qF -- "$FAC_READY" "$DATA/facilitator.log" 2>/dev/null; then note="ready"; else note="no ready line yet"; fi
        ;;
      api)
        if grep -qF -- "$API_READY" "$DATA/api.log" 2>/dev/null; then note="ready"; else note="no ready line yet"; fi
        ;;
      clock)
        note="$(tail -n 1 "$DATA/clock.log" 2>/dev/null | redact || true)"
        ;;
    esac
    printf '    %-12s running  pid %-7s %s\n' "$name" "$(pid_of "$name")" "$note"
  elif is_orphaned "$name"; then
    printf '    %-12s leader exited, members of its process group still run (scripts/demo.sh down stops them)\n' "$name"
  else
    printf '    %-12s not running\n' "$name"
  fi
}

cmd_status() {
  local height balance
  [ $# -eq 0 ] || die "status takes no arguments"
  need node jq

  step "Processes started by this script"
  print_proc clock
  print_proc facilitator
  print_proc api

  step "Chain"
  if height="$(zrpc zebra getblockcount 2>/dev/null)"; then
    info "Zebra tip    height $height"
  else
    info "Zebra tip    not answering, run scripts/demo.sh up"
  fi

  step "Agent wallet"
  if balance="$(spendable_zat 2>/dev/null)" && [ -n "$balance" ]; then
    case "$balance" in
      *[!0-9]*) info "spendable    unexpected balance \"$balance\"" ;;
      *)
        if [ "$balance" -ge "$FLOOR_ZAT" ]; then
          info "spendable    $(commas "$balance") zat, enough (the demo needs $(commas "$FLOOR_ZAT"))"
        else
          info "spendable    $(commas "$balance") zat, LOW (the demo needs $(commas "$FLOOR_ZAT")), run: bash infra/z3/fund-agent.sh"
        fi
        ;;
    esac
  else
    info "spendable    Zallet not answering, run scripts/demo.sh up"
  fi
}

# Prints the pids of every descendant of $1 by walking the ppid tree, since pnpm 12 can start the server in its own group
descendants_of() {
  ps -A -o pid=,ppid= 2>/dev/null | awk -v root="$1" '
    { kids[$2] = kids[$2] " " $1 }
    END {
      n = split(kids[root], queue, " ")
      for (i = 1; i <= n; i++) {
        print queue[i]
        m = split(kids[queue[i]], more, " ")
        for (j = 1; j <= m; j++) queue[++n] = more[j]
      }
    }' || true
}

# wait_gone <pgid> <seconds> <descendant pids> returns 0 once the group and every listed pid have exited
wait_gone() {
  local pid="$1" i=0 max=$(($2 * 5)) extra="$3" d busy
  while :; do
    busy=0
    if kill -0 -- "-$pid" 2>/dev/null; then busy=1; fi
    for d in $extra; do
      if kill -0 "$d" 2>/dev/null; then busy=1; fi
    done
    if [ "$busy" -eq 0 ]; then return 0; fi
    i=$((i + 1))
    if [ "$i" -gt "$max" ]; then return 1; fi
    sleep 0.2
  done
}

stop_proc() {
  local name="$1" pid desc="" d
  if [ ! -f "$DATA/$name.pid" ]; then
    info "$name: no pidfile, nothing to stop"
    return 0
  fi
  if is_alive "$name"; then
    pid="$(pid_of "$name")"
    desc="$(descendants_of "$pid" | tr '\n' ' ')"
  elif is_orphaned "$name"; then
    pid="$(pid_of "$name")"
    info "$name: its leader exited, signalling the members of its process group"
  else
    info "$name: not running, removing its stale pidfile (nothing was signalled)"
    rm -f "$DATA/$name.pid"
    return 0
  fi
  info "$name: SIGINT to pid $pid and its process group"
  kill -s INT -- "-$pid" 2>/dev/null || true
  if ! wait_gone "$pid" 20 "$desc"; then
    warn "$name ignored SIGINT for 20s, sending SIGTERM"
    kill -s TERM -- "-$pid" 2>/dev/null || true
    for d in $desc; do kill -s TERM "$d" 2>/dev/null || true; done
    if ! wait_gone "$pid" 10 "$desc"; then
      warn "$name is still running, force it with: kill -9 -- -$pid $desc"
      return 1
    fi
  fi
  rm -f "$DATA/$name.pid"
  info "$name: stopped"
}

cmd_down() {
  local wipe=0 failed=0 a
  for a in "$@"; do
    case "$a" in
      --wipe-ledger) wipe=1 ;;
      *) die "down: unknown argument $a (usage: scripts/demo.sh down [--wipe-ledger])" ;;
    esac
  done

  step "Stopping the demo processes (clock, api, facilitator)"
  stop_proc clock || failed=1
  stop_proc api || failed=1
  stop_proc facilitator || failed=1

  if [ "$wipe" -eq 1 ]; then
    step "Ledger"
    if port_open "$FAC_PORT"; then
      die "something still listens on $FAC_URL, not deleting the ledger under it"
    fi
    if [ -e "$LEDGER" ]; then
      rm -f "$LEDGER"
      info "deleted .data/facilitator-ledger.$NETWORK.jsonl"
    else
      info "no ledger at .data/facilitator-ledger.$NETWORK.jsonl"
    fi
    info "The ledger and the chain must be reset together. If the chain is not wiped yet, run"
    info "bash infra/z3/down.sh --wipe yourself, then bash infra/z3/up.sh and bash infra/z3/fund-agent.sh"
    info "(this script never touches Docker)."
  fi
  return "$failed"
}

main() {
  local cmd="${1:-}"
  if [ $# -gt 0 ]; then shift; fi
  case "$cmd" in
    up) cmd_up "$@" ;;
    clock) cmd_clock "$@" ;;
    honest) cmd_honest "$@" ;;
    cheat) cmd_cheat "$@" ;;
    show) cmd_show "$@" ;;
    status) cmd_status "$@" ;;
    down) cmd_down "$@" ;;
    -h | --help | help) usage ;;
    '')
      usage >&2
      exit 2
      ;;
    *)
      printf 'unknown command: %s\n\n' "$cmd" >&2
      usage >&2
      exit 2
      ;;
  esac
}

main "$@"
