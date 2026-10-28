#!/usr/bin/env bash
# Shows a deposit transaction as the chain stores it, then as the merchant's viewing key reads it.
#
#   scripts/show-deposit.sh <txid> [--network regtest|testnet|mainnet] [--keys <file>]
#
# The raw transaction comes from Zebra through getrawtransaction with verbose 1, at Z3_ZEBRA_RPC with Basic auth from
# Z3_RPC_USER and Z3_RPC_PASSWORD (the defaults are the Z3 regtest ones, see usage). zdecrypt decrypts it at its
# mined height, or at the chain tip plus one while it is in the mempool. The keys file supplies the viewing key and the
# payTo address. The key reaches zdecrypt through ZDECRYPT_KEY only, so it is never an argument and never printed.
# The JSON report goes to stdout, pretty-printed by jq with every non-ASCII and control character escaped, and all
# commentary to stderr, so the report can be piped. scripts/demo.sh show runs this script with just the txid.

# An inherited xtrace (bash -x or SHELLOPTS) would print the viewing key and the RPC password
set +x
set -euo pipefail
export LC_ALL=C

HERE="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null && pwd)"
ROOT="$(CDPATH='' cd -- "$HERE/.." >/dev/null && pwd)"
ZDECRYPT="$ROOT/crates/zdecrypt/target/release/zdecrypt"

RPC_URL="${Z3_ZEBRA_RPC:-http://127.0.0.1:29232}"
RPC_USER="${Z3_RPC_USER:-zebra}"
RPC_PASSWORD="${Z3_RPC_PASSWORD:-zebra}"

usage() {
  cat <<'EOF'
usage: scripts/show-deposit.sh <txid> [--network regtest|testnet|mainnet] [--keys <file>]

Shows a deposit transaction as the chain stores it, then as the merchant's viewing key reads it.

  <txid>      the transaction id, 64 lowercase hex characters
  --network   network of the transaction and of the keys (default regtest)
  --keys      a zdecrypt keygen JSON (default .secrets/merchant-<network>.json), a relative path
              is relative to the repository root

Environment (the Z3 regtest defaults):
  Z3_ZEBRA_RPC      Zebra JSON-RPC URL (http://127.0.0.1:29232)
  Z3_RPC_USER       Basic auth user (zebra)
  Z3_RPC_PASSWORD   Basic auth password (zebra)

The JSON report goes to stdout and everything else to stderr. The viewing key reaches zdecrypt through
ZDECRYPT_KEY only and is never printed.
EOF
}

step() { printf '\n==> %s\n' "$*" >&2; }
info() { printf '    %s\n' "$*" >&2; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}
usage_error() {
  printf 'ERROR: %s\n\n' "$*" >&2
  usage >&2
  exit 2
}

# A path as it reads from the repository root, when it is inside it
shown() { printf '%s' "${1#"$ROOT"/}"; }

need() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "$c is required but was not found on PATH"
  done
}

# Text safe to print, with tab, CR and LF as spaces, no other controls, no invalid UTF-8 and at most 200 characters
plain() {
  perl -e 'use Encode qw(decode encode); local $/; my $s = decode("UTF-8", scalar(<STDIN>) // "", sub { "" });
    $s =~ tr/\t\r\n/ /; $s =~ s/[\x00-\x1f\x7f-\x9f]//g; print encode("UTF-8", substr($s, 0, 200))'
}

# Calls Zebra and prints the result as JSON, or dies with the reason
rpc() {
  local method="$1" params="$2" reply reason
  reply="$(curl -q -sS --noproxy '*' --connect-timeout 5 --max-time 30 -K - -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}" "$RPC_URL" \
    <<<"header = \"Authorization: Basic $AUTH\"")" ||
    die "cannot reach Zebra at $RPC_URL (is the Z3 stack up? bash infra/z3/up.sh)"
  jq -s -e 'length == 1 and (.[0] | type == "object")' >/dev/null 2>&1 <<<"$reply" ||
    die "Zebra at $RPC_URL did not answer $method with JSON-RPC (wrong Z3_ZEBRA_RPC, Z3_RPC_USER or Z3_RPC_PASSWORD?)"
  if jq -e '.error != null' >/dev/null <<<"$reply"; then
    reason="$(jq -j '.error | if type == "object" then .message // "unknown error" else . end | tostring' \
      <<<"$reply" | plain)"
    die "Zebra $method failed: ${reason:-unknown error}"
  fi
  jq -c '.result' <<<"$reply"
}

TXID=""
NETWORK="regtest"
KEYS=""

while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --network)
      [ $# -ge 2 ] || usage_error "--network needs a value"
      NETWORK="$2"
      shift 2
      ;;
    --network=*)
      NETWORK="${1#--network=}"
      shift
      ;;
    --keys)
      [ $# -ge 2 ] || usage_error "--keys needs a value"
      KEYS="$2"
      shift 2
      ;;
    --keys=*)
      KEYS="${1#--keys=}"
      shift
      ;;
    -*) usage_error "unknown option ${1%%=*}" ;;
    *)
      [ -z "$TXID" ] || usage_error "only one txid is accepted"
      TXID="$1"
      shift
      ;;
  esac
done

[ -n "$TXID" ] || usage_error "a txid is required"
case "$TXID" in
  *[!0-9a-f]*) usage_error "the txid must be 64 lowercase hex characters" ;;
esac
[ "${#TXID}" -eq 64 ] || usage_error "the txid must be 64 lowercase hex characters"

case "$NETWORK" in
  regtest | testnet | mainnet) ;;
  *) usage_error "--network must be regtest, testnet or mainnet" ;;
esac

if [ -z "$KEYS" ]; then
  KEYS="$ROOT/.secrets/merchant-$NETWORK.json"
fi
case "$KEYS" in
  /*) ;;
  *) KEYS="$ROOT/$KEYS" ;;
esac

need curl jq base64 perl
[ -x "$ZDECRYPT" ] || die "$(shown "$ZDECRYPT") is not built (pnpm --filter @z402/facilitator build:native)"
if [ ! -f "$KEYS" ]; then
  die "$(shown "$KEYS") not found (create it with: node scripts/merchant-keygen.mjs --network $NETWORK, or pass --keys)"
fi
[ -r "$KEYS" ] || die "cannot read $(shown "$KEYS")"

# The viewing key lives in uivk, and the ZDECRYPT_KEY assignment below is the only place it leaves
pay_to="$(jq -r '.orchardOnlyAddress // empty' "$KEYS" 2>/dev/null)" || die "$(shown "$KEYS") is not valid JSON"
uivk="$(jq -r '.uivk // empty' "$KEYS" 2>/dev/null)" || die "$(shown "$KEYS") is not valid JSON"
keys_network="$(jq -r '.network // empty' "$KEYS" 2>/dev/null)" || die "$(shown "$KEYS") is not valid JSON"
[ -n "$pay_to" ] || die ".orchardOnlyAddress is missing from $(shown "$KEYS")"
[ -n "$uivk" ] || die ".uivk is missing from $(shown "$KEYS")"
if [ -n "$keys_network" ] && [ "$keys_network" != "$NETWORK" ]; then
  die "$(shown "$KEYS") holds $keys_network keys, not $NETWORK keys"
fi

AUTH="$(printf '%s' "$RPC_USER:$RPC_PASSWORD" | base64 | tr -d '\n')"

step "Deposit $TXID"
tx="$(rpc getrawtransaction "[\"$TXID\",1]")" || exit 1
jq -s -e 'length == 1 and (.[0] | type == "object")' >/dev/null 2>&1 <<<"$tx" ||
  die "Zebra returned an unexpected getrawtransaction result"
hex="$(jq -r '.hex // empty' <<<"$tx")"
height="$(jq -r '.height // empty' <<<"$tx")"
confirmations="$(jq -r '.confirmations // empty' <<<"$tx")"
case "$hex" in
  '' | *[!0-9a-f]*) die "Zebra returned something that is not transaction hex" ;;
esac
case "$confirmations" in
  *[!0-9]*) die "Zebra returned an unexpected confirmation count" ;;
esac
[ $((${#hex} % 2)) -eq 0 ] || die "Zebra returned transaction hex of odd length"

if [ -n "$height" ]; then
  case "$height" in
    -1) die "the transaction is only on a side chain (not in the best chain), so it is not a usable deposit" ;;
    *[!0-9]*) die "Zebra returned an unexpected height" ;;
  esac
  at_flag="--height"
  at_value="$height"
  info "mined at height $height${confirmations:+, $confirmations confirmations}"
else
  tip="$(rpc getblockcount '[]')" || exit 1
  case "$tip" in
    '' | *[!0-9]*) die "Zebra returned an unexpected block count" ;;
  esac
  at_flag="--tip"
  at_value="$tip"
  info "still in the mempool, judged at tip $tip + 1"
fi
info "raw transaction: $((${#hex} / 2)) bytes (${#hex} hex characters)"
info "starts with:     ${hex:0:96}..."
info "That hex is all a block explorer has. Its shielded outputs hold no plaintext amount or address, only ciphertext."

step "Decrypted with the merchant's viewing key (UIVK, not printed)"
report="$(ZDECRYPT_KEY="$uivk" "$ZDECRYPT" decrypt --network "$NETWORK" "$at_flag" "$at_value" \
  --pay-to "$pay_to" <<<"$hex")" || die "zdecrypt could not decrypt the transaction"
reported="$(jq -r '.txid // empty' 2>/dev/null <<<"$report")"
[ "$reported" = "$TXID" ] || die "Zebra returned a transaction that is not $TXID"
# The memo is chosen by the sender, so ASCII only keeps its control and bidirectional characters off the terminal
jq -a . <<<"$report"
if jq -e '.transparentIn == 0 and .transparentOut == 0' >/dev/null 2>&1 <<<"$report"; then
  info "Only the net value balance (here the fee) is public."
else
  info "This transaction also has a transparent part, which is public."
fi
